;;;; soz.lisp — Reference checker for the soz plan language, version 0.1 (see ../../SPEC.md).
;;;; SBCL, no dependencies besides json.lisp in this folder. Nothing in a plan is ever evaluated:
;;;; the reader below is not the Lisp reader and never creates symbols.

(defpackage :soz
  (:use :cl)
  (:export #:check-plan #:read-plan #:define-operation #:operation-from-json #:*operations*
           #:result-valid #:result-errors #:result-effects #:result-requires-approval
           #:result-max-calls #:result-may-stop #:result-calls #:result-json
           #:soz-error-code #:soz-error-line #:soz-error-column #:soz-error-message
           #:error-report #:plan-summary #:fold #:name-fold #:message-numbers
           #:*max-length* #:*max-depth* #:*max-tokens* #:*max-list* #:*max-calls*))

(in-package :soz)

(defparameter *max-length* 20000)
(defparameter *max-depth* 32)
(defparameter *max-tokens* 5000)
(defparameter *max-list* 50)
(defparameter *max-calls* 500)

;;; ------------------------------------------------------------------
;;; Folding (SPEC 3)
;;; ------------------------------------------------------------------

(defun fold (s)
  (with-output-to-string (o)
    (loop for c across (sb-unicode:normalize-string s :nfd)
          unless (<= #x300 (char-code c) #x36f)
            do (let ((l (char-downcase c)))
                 (write-char (if (char= l (code-char #x131)) #\i l) o)))))

(defun name-fold (s) (substitute #\- #\_ (fold s)))

;;; ------------------------------------------------------------------
;;; Reader (SPEC 2)
;;; ------------------------------------------------------------------

(defstruct (node (:constructor node (kind value line column &optional text)))
  kind      ; :list :text :number :name
  value     ; child nodes / string / rational / the name as written
  line column
  text)     ; numbers and names: as written

(define-condition syntax-error (error)
  ((code :initarg :code :reader syntax-error-code)
   (line :initarg :line :reader syntax-error-line)
   (column :initarg :column :reader syntax-error-column)
   (message :initarg :message :reader syntax-error-message))
  (:report (lambda (c s) (format s "~d:~d ~a: ~a" (syntax-error-line c) (syntax-error-column c)
                                 (syntax-error-code c) (syntax-error-message c)))))

(defun atom-char-p (c) (or (alphanumericp c) (find c "-_.?!<>=+*/")))
(defun space-char-p (c) (member c '(#\Space #\Tab #\Newline #\Return)))

(defun parse-number (s)
  "-?[0-9]+(\\.[0-9]+)? -> exact rational, else NIL."
  (let* ((neg (and (> (length s) 1) (char= (char s 0) #\-)))
         (g (if neg (subseq s 1) s))
         (dot (position #\. g)))
    (when (and (plusp (length g))
               (every (lambda (c) (or (char<= #\0 c #\9) (char= c #\.))) g)
               (<= (count #\. g) 1)
               (char<= #\0 (char g 0) #\9)
               (char<= #\0 (char g (1- (length g))) #\9))
      (let ((v (+ (parse-integer g :end dot)
                  (if dot (/ (parse-integer g :start (1+ dot)) (expt 10 (- (length g) dot 1))) 0))))
        (if neg (- v) v)))))

(defun read-plan (text)
  "Reads TEXT as exactly one list and returns its NODE tree. Signals SYNTAX-ERROR."
  (let ((i 0) (n (length text)) (line 1) (col 1) (tokens 0))
    (labels ((fail-at (code l c fmt &rest args)
               (error 'syntax-error :code code :line l :column c :message (apply #'format nil fmt args)))
             (fail (code fmt &rest args) (apply #'fail-at code line col fmt args))
             (peek () (and (< i n) (char text i)))
             (next ()
               (let ((c (char text i)))
                 (incf i)
                 (if (char= c #\Newline) (setf line (1+ line) col 1) (incf col))
                 c))
             (skip ()
               (loop (let ((c (peek)))
                       (cond ((null c) (return))
                             ((space-char-p c) (next))
                             ((char= c #\;) (loop while (and (peek) (char/= (peek) #\Newline)) do (next)))
                             (t (return))))))
             (item (depth)
               (skip)
               (let ((c (peek)) (l line) (cl col))
                 (when (and c (char/= c #\)) (> (incf tokens) *max-tokens*))
                   (fail "too-large" "the plan has more than ~d tokens" *max-tokens*))
                 (cond
                   ((null c) (fail "unexpected-end" "the plan ended early; is a parenthesis missing?"))
                   ((char= c #\()
                    (when (>= depth *max-depth*) (fail "too-deep" "lists nested deeper than ~d" *max-depth*))
                    (next)
                    (let ((items '()))
                      (loop (skip)
                            (let ((c2 (peek)))
                              (cond ((null c2) (fail-at "unclosed-list" l cl "this list is not closed"))
                                    ((char= c2 #\)) (next) (return (node :list (nreverse items) l cl)))
                                    (t (push (item (1+ depth)) items)))))))
                   ((char= c #\)) (fail "unexpected-close" "unexpected closing parenthesis"))
                   ((char= c #\")
                    (next)
                    (let ((o (make-string-output-stream)))
                      (loop (let ((c2 (peek)))
                              (cond ((null c2) (fail-at "unclosed-text" l cl "this text is not closed"))
                                    ((char= c2 #\") (next) (return (node :text (get-output-stream-string o) l cl)))
                                    ((char= c2 #\\)
                                     (next)
                                     (unless (and (peek) (find (peek) "\"\\"))
                                       (fail "bad-escape" "only \\\" and \\\\ are allowed after a backslash"))
                                     (write-char (next) o))
                                    (t (write-char (next) o)))))))
                   ((atom-char-p c)
                    (let ((o (make-string-output-stream)))
                      (loop while (and (peek) (atom-char-p (peek))) do (write-char (next) o))
                      (let ((s (get-output-stream-string o)))
                        (when (and (peek) (not (space-char-p (peek))) (not (find (peek) "();")))
                          (fail "illegal-character" "character ~s is not allowed here" (peek)))
                        (let ((v (parse-number s)))
                          (cond (v (node :number v l cl s))
                                ((digit-char-p (char s 0)) (fail-at "bad-token" l cl "~a is neither a number nor a name" s))
                                (t (node :name s l cl s)))))))
                   (t (fail "illegal-character"
                            "character ~s is not allowed (a plan has only parentheses, \"texts\", numbers and names)" c))))))
      (when (> n *max-length*) (fail "too-long" "the plan is longer than ~d characters" *max-length*))
      (let ((root (item 0)))
        (skip)
        (when (peek) (fail "trailing-content" "there is content after the plan; a plan is a single (plan ...) list"))
        root))))

;;; ------------------------------------------------------------------
;;; Operations (SPEC 6). Types: :text :number :bool :any (:list T) (:record (name . T) ...)
;;; ------------------------------------------------------------------

(defstruct (operation (:conc-name op-)) name effect params returns)
(defstruct (param (:conc-name pa-)) name type required model-allowed)

(defvar *operations* (make-hash-table :test #'equal) "name-fold -> OPERATION")

(defparameter *effects* '("read" "write" "external" "money")
  "Built-in effects, in result order. Any other effect name is a custom side effect (SPEC 6).")

(defun lower-letter-p (c) (and (char<= (code-char 97) c (code-char 122)) t))

(defun effect-name-p (s)
  (and (stringp s) (plusp (length s)) (lower-letter-p (char s 0))
       (every (lambda (c) (or (lower-letter-p c) (digit-char-p c) (find c "._-"))) s)))

(defun effect-order (effects)
  (append (remove-if-not (lambda (e) (member e effects :test #'string=)) *effects*)
          (sort (remove-if (lambda (e) (member e *effects* :test #'string=))
                           (remove-duplicates effects :test #'string=))
                #'string<)))

(defun side-effect-p (effect) (string/= effect "read"))

(defun type-from-json (j)
  (let ((ty (and (hash-table-p j) (gethash "type" j))))
    (cond ((null j) :any)
          ((member ty '("text" "number" "bool" "any") :test #'equal) (intern (string-upcase ty) :keyword))
          ((equal ty "list") (list :list (type-from-json (gethash "items" j))))
          ((equal ty "record")
           (cons :record (let ((f (gethash "fields" j)) (out '()))
                           (when f (maphash (lambda (k v) (push (cons (name-fold k) (type-from-json v)) out)) f))
                           (sort out #'string< :key #'car))))
          (t (error "unknown type in operation declaration: ~s" ty)))))

(defun json-true-p (v) (eq v :true))

(defun operation-from-json (j)
  "Builds an OPERATION from its JSON declaration (a hash table) and registers it."
  (let* ((name (gethash "name" j))
         (effect (gethash "effect" j "write"))
         (params '()))
    (unless (effect-name-p effect) (error "bad effect name ~s in operation ~a" effect name))
    (let ((ps (gethash "params" j)))
      (when ps
        (maphash (lambda (k v)
                   (push (make-param :name k :type (type-from-json v)
                                     :required (not (eq (gethash "required" v) :false))
                                     :model-allowed (json-true-p (gethash "model_allowed" v)))
                         params))
                 ps)))
    (setf (gethash (name-fold name) *operations*)
          (make-operation :name name :effect effect :params (nreverse params)
                          :returns (type-from-json (gethash "returns" j))))))

(defun lisp-type (spec)
  (cond ((member spec '(:text :number :bool :any)) spec)
        ((eq (first spec) :list) (list :list (lisp-type (second spec))))
        ((eq (first spec) :record)
         (cons :record (sort (mapcar (lambda (f) (cons (name-fold (string-downcase (string (first f))))
                                                       (lisp-type (second f))))
                                     (rest spec))
                             #'string< :key #'car)))
        (t (error "unknown type ~s" spec))))

(defmacro define-operation (name (&key (effect "write") (returns :any)) &rest params)
  "Lisp-side declaration: (define-operation erp.stock (:effect :read :returns (:list ...)) (product :text :required nil))"
  `(setf (gethash (name-fold ,(string-downcase (string name))) *operations*)
         (make-operation :name ,(string-downcase (string name)) :effect ,(string-downcase (string effect)) :returns (lisp-type ',returns)
                         :params (list ,@(mapcar (lambda (p)
                                                   (destructuring-bind (pn ty &key (required t) model-allowed) p
                                                     `(make-param :name ,(string-downcase (string pn)) :type (lisp-type ',ty)
                                                                  :required ,required :model-allowed ,model-allowed)))
                                                 params)))))

;;; ------------------------------------------------------------------
;;; Provenance helpers (SPEC 5.1)
;;; ------------------------------------------------------------------

(defun message-numbers (message)
  (let ((out '()) (i 0) (n (length message)))
    (flet ((digit (k) (and (< -1 k n) (char<= #\0 (char message k) #\9))))
      (loop while (< i n)
            do (if (digit i)
                   (let ((start i))
                     (loop while (and (< i n) (or (digit i) (and (find (char message i) ".,") (digit (1+ i)))))
                           do (incf i))
                     (let* ((run (subseq message start i))
                            (readings (list (and (every #'digit-char-p run) run)
                                            (let ((r (remove #\. run))) (and (<= (count #\, r) 1) (substitute #\. #\, r)))
                                            (let ((r (remove #\, run))) (and (<= (count #\. r) 1) r))
                                            (remove-if-not #'digit-char-p run))))
                       (dolist (r readings)
                         (let ((v (and r (parse-number r))))
                           (when v (pushnew v out))))))
                   (incf i))))
    out))

(defun text-in-message-p (literal message)
  (let ((f (fold (string-trim '(#\Space #\Tab #\Newline #\Return) literal)))
        (m (fold message)))
    (and (>= (length f) 2)
         (loop for start = 0 then (1+ pos)
               for pos = (search f m :start2 start)
               while pos
               thereis (or (zerop pos) (not (alphanumericp (char m (1- pos)))))))))

(defun number-in-message-p (value message)
  (and (>= value 0) (member value (message-numbers message) :test #'=)))

;;; ------------------------------------------------------------------
;;; Checker
;;; ------------------------------------------------------------------

(defstruct (val (:conc-name v-))
  (type :any)   ; :text :number :bool :list :record :none :any :error
  item          ; :list -> element VAL
  fields        ; :record -> ((name . VAL) ...)
  length        ; known list length
  sources       ; (:message :tool :model)
  invented)     ; literal NODEs not in the message

(defstruct (call (:conc-name call-)) operation line max-count conditional)
(defstruct (soz-error (:conc-name soz-error-)) code line column message)
(defstruct (result (:conc-name result-)) valid errors effects requires-approval max-calls may-stop calls title)

(defvar *errors*)
(defvar *message*)
(defvar *multiplier*)
(defvar *condition*)
(defvar *conditional*)
(defvar *calls*)
(defvar *may-stop*)

(defun err (node code fmt &rest args)
  (push (make-soz-error :code code :line (if node (node-line node) 1) :column (if node (node-column node) 1)
                        :message (apply #'format nil fmt args))
        *errors*)
  (make-val :type :error))

(defun unions (vals)
  (values (remove-duplicates (loop for v in vals append (v-sources v)))
          (remove-duplicates (loop for v in vals append (v-invented v)))))

(defun derived (type vals)
  (multiple-value-bind (s i) (unions vals) (make-val :type type :sources s :invented i)))

(defun join (a b)
  "Common value of list elements or IF branches; NIL if they cannot be joined."
  (multiple-value-bind (s i) (unions (list a b))
    (let ((ta (v-type a)) (tb (v-type b)))
      (cond ((member ta '(:error :any)) (make-val :type ta :sources s :invented i))
            ((member tb '(:error :any)) (make-val :type tb :sources s :invented i))
            ((not (eq ta tb)) nil)
            ((eq ta :record)
             (let ((fa (v-fields a)) (fb (v-fields b)))
               (when (and (= (length fa) (length fb)) (every (lambda (x) (assoc (car x) fb :test #'string=)) fa))
                 (make-val :type :record :sources s :invented i
                           :fields (loop for (k . v) in fa
                                         collect (cons k (or (join v (cdr (assoc k fb :test #'string=)))
                                                             (return-from join nil))))))))
            ((eq ta :list)
             (make-val :type :list :sources s :invented i
                       :item (cond ((null (v-item a)) (v-item b))
                                   ((null (v-item b)) (v-item a))
                                   (t (or (join (v-item a) (v-item b)) (return-from join nil))))))
            (t (make-val :type ta :sources s :invented i))))))

(defun val-of-type (type)
  "Value returned by an operation: everything in it comes from the tool."
  (let ((s (list :tool)))
    (cond ((keywordp type) (make-val :type type :sources s))
          ((eq (first type) :list) (make-val :type :list :sources s :item (val-of-type (second type))))
          (t (make-val :type :record :sources s
                       :fields (mapcar (lambda (f) (cons (car f) (val-of-type (cdr f)))) (rest type)))))))

(defun fits-p (type v)
  (let ((g (v-type v)))
    (or (member g '(:error :any))
        (eq type :any)
        (if (keywordp type)
            (eq g type)
            (case (first type)
              (:list (and (eq g :list) (or (null (v-item v)) (fits-p (second type) (v-item v)))))
              (:record (and (eq g :record)
                            (every (lambda (f) (let ((x (assoc (car f) (v-fields v) :test #'string=)))
                                                 (and x (fits-p (cdr f) (cdr x)))))
                                   (rest type)))))))))

(defun type-name (type)
  (cond ((keywordp type) (string-downcase (symbol-name type)))
        ((eq (first type) :list) (format nil "list of ~a" (type-name (second type))))
        (t (format nil "record (~{~a~^, ~})" (mapcar #'car (rest type))))))

(defun literal (node)
  (let* ((type (if (eq (node-kind node) :number) :number :text))
         (in (and *message*
                  (if (eq type :number)
                      (number-in-message-p (node-value node) *message*)
                      (text-in-message-p (node-value node) *message*)))))
    (if in
        (make-val :type type :sources (list :message))
        (make-val :type type :sources (list :model) :invented (list node)))))

(defun literal-text (node)
  (if (eq (node-kind node) :text) (format nil "~s" (node-value node)) (node-text node)))

(defun name-p (node) (and node (eq (node-kind node) :name)))

(defun check-body (body env)
  (let ((last (make-val :type :none)))
    (dolist (e body last) (setf last (check-expr e env)))))

(defun check-expr (node env)
  (ecase (node-kind node)
    ((:number :text) (literal node))
    (:name (let ((b (assoc (name-fold (node-value node)) env :test #'string=)))
             (if b
                 (cdr b)
                 (err node "unknown-name" "~a is not defined~@[; names defined here: ~{~a~^, ~}~]"
                      (node-value node)
                      (let ((names (remove-duplicates (mapcar #'car env) :test #'string= :from-end t)))
                        (subseq names 0 (min 12 (length names))))))))
    (:list (check-form node env))))

(defun want (node v type)
  (unless (fits-p type v)
    (err node "type-mismatch" "expected ~a, got ~a" (type-name type) (type-name (v-type v)))))

(defun form-is (k &rest names) (member k names :test #'string=))

(defun check-form (node env)
  (let* ((items (node-value node)) (head (first items)) (args (rest items)))
    (cond
      ((null items) (err node "empty-form" "empty list"))
      ((not (name-p head)) (err node "bad-form" "a list must start with a name (a form or an operation)"))
      (t
       (let ((k (name-fold (node-value head))))
         (cond
           ((form-is k "plan") (err node "bad-form" "(plan ...) is only allowed at the top"))
           ((form-is k "let") (check-let node args env))
           ((form-is k "for-each") (check-for-each node args env))
           ((form-is k "if") (check-if node args env))
           ((form-is k "do")
            (if args (check-body args env) (err node "bad-form" "(do ...) needs at least one expression")))
           ((form-is k "stop")
            (setf *may-stop* t)
            (if args
                (progn (dolist (a args) (check-expr a env)) (make-val :type :none))
                (err node "bad-form" "(stop \"reason\") must tell the user why")))
           ((form-is k "list") (check-list node args env))
           ((form-is k "record") (check-record node args env))
           ((form-is k "get") (check-get node args env))
           ((form-is k "+" "-" "*" "/")
            (when (or (null args) (and (form-is k "/") (/= (length args) 2)))
              (err node "bad-form" "~a needs ~:[at least one number~;two numbers~]" k (form-is k "/")))
            (when (and (form-is k "/") (second args) (eq (node-kind (second args)) :number)
                       (zerop (node-value (second args))))
              (err (second args) "division-by-zero" "division by zero"))
            (derived :number (mapcar (lambda (a) (let ((v (check-expr a env))) (want a v :number) v)) args)))
           ((form-is k "=" "!=" "<" ">" "<=" ">=")
            (unless (= (length args) 2) (err node "bad-form" "~a compares two values" k))
            (let ((vs (mapcar (lambda (a) (check-expr a env)) args)))
              (unless (form-is k "=" "!=")
                (loop for a in args for v in vs do (want a v :number)))
              (derived :bool vs)))
           ((form-is k "and" "or" "not")
            (when (or (null args) (and (form-is k "not") (/= (length args) 1)))
              (err node "bad-form" "~a needs ~:[at least one condition~;exactly one condition~]" k (form-is k "not")))
            (derived :bool (mapcar (lambda (a) (let ((v (check-expr a env))) (want a v :bool) v)) args)))
           (t
            (let ((op (gethash k *operations*)))
              (if op
                  (check-call node op args env)
                  (progn
                    (err head "unknown-operation" "unknown operation ~a; available operations: ~{~a~^, ~}"
                         (node-value head)
                         (sort (loop for o being the hash-values of *operations* collect (op-name o)) #'string<))
                    (dolist (a args) (when (eq (node-kind a) :list) (check-expr a env)))
                    (make-val :type :error)))))))))))

(defun check-let (node args env)
  (let ((bindings (first args)) (body (rest args)))
    (unless (and bindings (eq (node-kind bindings) :list))
      (return-from check-let (err node "bad-form" "write (let ((name value) ...) body)")))
    (dolist (b (node-value bindings))
      (let ((parts (and (eq (node-kind b) :list) (node-value b))))
        (if (and (= (length parts) 2) (name-p (first parts)))
            (push (cons (name-fold (node-value (first parts))) (check-expr (second parts) env)) env)
            (err b "bad-form" "each binding is (name value)"))))
    (if body (check-body body env) (err node "bad-form" "let has no body"))))

(defun check-for-each (node args env)
  (let* ((spec (first args)) (parts (and spec (eq (node-kind spec) :list) (node-value spec))))
    (unless (and (= (length parts) 2) (name-p (first parts)) (rest args))
      (return-from check-for-each (err node "bad-form" "write (for-each (name list) body)")))
    (let* ((l (check-expr (second parts) env))
           (n (case (v-type l)
                (:error 1)
                (:list (or (v-length l) *max-list*))
                (t (err (second parts) "not-a-list" "for-each runs only over a list; this is ~a" (type-name (v-type l)))
                   1)))
           (item (if (eq (v-type l) :list)
                     (or (v-item l) (make-val :type :any :sources (v-sources l)))
                     (make-val :type :error))))
      (let ((*multiplier* (* *multiplier* (max n 1))))
        (check-body (rest args) (acons (name-fold (node-value (first parts))) item env)))
      (make-val :type :none))))

(defun check-if (node args env)
  (unless (<= 2 (length args) 3)
    (return-from check-if (err node "bad-form" "write (if condition then [else]); use (do ...) for several steps")))
  (let ((c (check-expr (first args) env)))
    (want (first args) c :bool)
    (let* ((*condition* (if *condition* (derived :bool (list *condition* c)) c))
           (*conditional* t)
           (a (check-expr (second args) env))
           (b (if (third args) (check-expr (third args) env) (make-val :type :none))))
      (or (join a b) (make-val :type :any)))))

(defun check-list (node args env)
  (when (> (length args) *max-list*)
    (err node "list-too-long" "the list has ~d elements (at most ~d)" (length args) *max-list*))
  (let* ((vs (mapcar (lambda (a) (check-expr a env)) args))
         (item (when vs
                 (reduce (lambda (x y)
                           (or (join x y)
                               (progn (err node "mixed-list" "all elements of a list must have the same type (records the same fields)")
                                      (make-val :type :error))))
                         vs))))
    (multiple-value-bind (s i) (unions vs)
      (make-val :type :list :item item :length (length args) :sources s :invented i))))

(defun check-record (node args env)
  (unless (evenp (length args)) (err node "bad-form" "a record is written as field value pairs"))
  (let ((fields '()))
    (loop for (f v) on args by #'cddr
          do (cond ((not (name-p f)) (err f "bad-form" "a field name was expected"))
                   ((assoc (name-fold (node-value f)) fields :test #'string=)
                    (err f "duplicate-field" "field ~a is written twice" (node-value f)))
                   (v (push (cons (name-fold (node-value f)) (check-expr v env)) fields))))
    (setf fields (sort fields #'string< :key #'car))
    (multiple-value-bind (s i) (unions (mapcar #'cdr fields))
      (make-val :type :record :fields fields :sources s :invented i))))

(defun check-get (node args env)
  (unless (and (= (length args) 2) (name-p (second args)))
    (return-from check-get (err node "bad-form" "write (get record field)")))
  (let ((r (check-expr (first args) env)) (f (name-fold (node-value (second args)))))
    (case (v-type r)
      (:error r)
      (:any (make-val :type :any :sources (v-sources r) :invented (v-invented r)))
      (:record (or (cdr (assoc f (v-fields r) :test #'string=))
                   (err (second args) "unknown-field" "there is no field ~a; fields: ~{~a~^, ~}"
                        (node-value (second args)) (mapcar #'car (v-fields r)))))
      (t (err (first args) "not-a-record" "get takes a field of a record; this is ~a" (type-name (v-type r)))))))

(defun check-call (node op args env)
  (let ((given '())
        (side-effect (side-effect-p (op-effect op)))
        (params (op-params op)))
    (unless (evenp (length args))
      (err node "bad-form" "~a: arguments are written as name value pairs" (op-name op)))
    (loop for (pn pv) on args by #'cddr
          do (cond
               ((not (name-p pn)) (err pn "bad-form" "a parameter name was expected"))
               (t
                (let* ((k (name-fold (node-value pn)))
                       (p (find k params :key (lambda (x) (name-fold (pa-name x))) :test #'string=)))
                  (cond
                    ((null p) (err pn "unknown-parameter" "~a has no parameter ~a; its parameters: ~{~a~^, ~}"
                                   (op-name op) (node-value pn) (mapcar #'pa-name params)))
                    ((assoc k given :test #'string=) (err pn "duplicate-parameter" "~a is given twice" (node-value pn)))
                    (pv
                     (let ((v (check-expr pv env)))
                       (push (cons k v) given)
                       (want pv v (pa-type p))
                       (when (and side-effect (not (pa-model-allowed p)))
                         (dolist (lit (v-invented v))
                           (err lit "invented-value"
                                "~a is not in the message; a value the model wrote cannot go to parameter ~a of ~a. Use the value from the message or from a read operation; if it is unknown, ask the user with (stop \"...\")."
                                (literal-text lit) (pa-name p) (op-name op)))))))))))
    (dolist (p params)
      (when (and (pa-required p) (not (assoc (name-fold (pa-name p)) given :test #'string=)))
        (err node "missing-parameter" "~a needs parameter ~a" (op-name op) (pa-name p))))
    (when (and side-effect *condition* (v-invented *condition*))
      (err node "invented-condition"
           "~a depends on a condition with ~{~a~^, ~}, which is not in the message: an operation that changes something cannot depend on a value the model made up"
           (op-name op) (mapcar #'literal-text (v-invented *condition*))))
    (push (make-call :operation op :line (node-line node) :max-count *multiplier* :conditional *conditional*) *calls*)
    (val-of-type (op-returns op))))

(defun sort-errors (errors)
  (stable-sort (remove-duplicates (reverse errors)
                                  :test (lambda (a b) (and (string= (soz-error-code a) (soz-error-code b))
                                                           (= (soz-error-line a) (soz-error-line b))
                                                           (= (soz-error-column a) (soz-error-column b))))
                                  :from-end t)
               (lambda (a b) (or (< (soz-error-line a) (soz-error-line b))
                                 (and (= (soz-error-line a) (soz-error-line b))
                                      (< (soz-error-column a) (soz-error-column b)))))))

(defun check-plan (text &key message)
  "Checks the plan in TEXT against MESSAGE (what the user wrote, or NIL). Runs nothing. Returns a RESULT."
  (let ((*errors* '()) (*message* message) (*multiplier* 1) (*condition* nil)
        (*conditional* nil) (*calls* '()) (*may-stop* nil) (title nil) (root nil))
    (handler-case
        (setf root (read-plan text))
      (syntax-error (e)
        (return-from check-plan
          (make-result :valid nil :effects '() :calls '() :max-calls 0
                       :errors (list (make-soz-error :code (syntax-error-code e) :line (syntax-error-line e)
                                                     :column (syntax-error-column e) :message (syntax-error-message e)))))))
    (let ((items (and (eq (node-kind root) :list) (node-value root))))
      (cond ((not (and (name-p (first items)) (string= (name-fold (node-value (first items))) "plan")
                       (second items) (eq (node-kind (second items)) :text)))
             (err root "not-a-plan" "a plan is written (plan \"title\" ...)"))
            ((null (cddr items)) (err root "empty-plan" "the plan is empty"))
            (t (setf title (node-value (second items)))
               (check-body (cddr items) '()))))
    (let* ((calls (reverse *calls*))
           (max-calls (reduce #'+ calls :key #'call-max-count :initial-value 0))
           (effects (effect-order (mapcar (lambda (c) (op-effect (call-operation c))) calls))))
      (when (> max-calls *max-calls*)
        (err root "too-many-calls" "the plan can make up to ~d operation calls (at most ~d; nested loops?)"
             max-calls *max-calls*))
      (let ((errors (sort-errors *errors*)))
        (make-result :valid (null errors) :errors errors :title title :effects effects
                     :requires-approval (and (some #'side-effect-p effects) t)
                     :max-calls max-calls :may-stop *may-stop* :calls calls)))))

;;; ------------------------------------------------------------------
;;; Output
;;; ------------------------------------------------------------------

(defun result-json (r)
  "The result as a JSON-ready hash table (SPEC 8)."
  (flet ((b (x) (if x :true :false)))
    (json:json-nesne
     "valid" (b (result-valid r))
     "errors" (map 'vector (lambda (e) (json:json-nesne "code" (soz-error-code e) "line" (soz-error-line e)
                                                        "column" (soz-error-column e) "message" (soz-error-message e)))
                   (result-errors r))
     "effects" (coerce (result-effects r) 'vector)
     "requires_approval" (b (result-requires-approval r))
     "max_calls" (result-max-calls r)
     "may_stop" (b (result-may-stop r))
     "calls" (map 'vector (lambda (c) (json:json-nesne "operation" (op-name (call-operation c))
                                                       "effect" (op-effect (call-operation c))
                                                       "line" (call-line c) "max_count" (call-max-count c)
                                                       "conditional" (b (call-conditional c))))
                  (result-calls r)))))

(defun error-report (r &key (limit 20))
  "For the model: why the plan did not run and what to fix."
  (let ((errs (result-errors r)))
    (format nil "The plan did not run. Fix these and send it again:~%~{~a~%~}~@[(~d more)~%~]"
            (loop for e in (subseq errs 0 (min limit (length errs))) for i from 1
                  collect (format nil "~d. line ~d, column ~d [~a]: ~a" i (soz-error-line e) (soz-error-column e)
                                  (soz-error-code e) (soz-error-message e)))
            (and (> (length errs) limit) (- (length errs) limit)))))

(defun plan-summary (r)
  "For the person approving: what the plan touches."
  (let ((groups '()))
    (dolist (c (result-calls r))
      (let* ((op (call-operation c)) (g (assoc (op-name op) groups :test #'string=)))
        (if g
            (progn (incf (second g) (call-max-count c)) (setf (fourth g) (or (fourth g) (call-conditional c))))
            (push (list (op-name op) (call-max-count c) (op-effect op) (call-conditional c)) groups))))
    (format nil "Plan: ~a~%Effects: ~:[none~;~:*~{~a~^, ~}~]~:[~; (needs approval)~]~%~{~a~%~}At most ~d operation calls.~:[~; The plan may stop on a condition.~]"
            (result-title r) (result-effects r) (result-requires-approval r)
            (loop for (name n effect cond) in (reverse groups)
                  collect (format nil "- ~a (~a~:[~*~;, up to ~d times~]~:[~;, conditional~])" name effect (> n 1) n cond))
            (result-max-calls r) (result-may-stop r))))
