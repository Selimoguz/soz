;;;; soz.lisp — Reference checker for the soz plan language (see ../../SPEC.md).
;;;; SBCL, no dependencies besides json.lisp in this folder. Nothing in a plan is ever evaluated:
;;;; the reader below is not the Lisp reader and never creates symbols.

(defpackage :soz
  (:use :cl)
  (:export #:check-plan #:read-plan #:define-operation #:operation-from-json #:*operations*
           #:result-valid #:result-errors #:result-effects #:result-requires-approval
           #:result-max-calls #:result-may-stop #:result-calls #:result-json
           #:soz-error-code #:soz-error-line #:soz-error-column #:soz-error-message
           #:error-report #:plan-summary #:fold #:name-fold #:message-numbers
           #:*max-length* #:*max-depth* #:*max-tokens* #:*max-list* #:*max-calls*
           #:policy-from-json #:actor-from-json #:make-actor #:actor-id #:actor-roles #:*policy* #:*actor*
           #:profile-from-json #:profile-numbers #:*profile*))

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
  "Reads TEXT as exactly one list and returns its NODE tree; a TEXT that starts with { is the JSON
syntax (SPEC 2.1). Signals SYNTAX-ERROR."
  (let ((first (position-if-not #'space-char-p text)))
    (when (and first (char= (char text first) #\{))
      (return-from read-plan (read-json-plan text))))
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

;;; --- The JSON syntax (SPEC 2.1): read into the same NODE tree as the s-expression it stands for

(defparameter *max-json-depth* 100)
(defparameter *json-operators* '("+" "-" "*" "/" "=" "!=" "<" ">" "<=" ">=" "and" "or" "not"))
(defparameter *json-expression-keys* '("var" "call" "let" "for_each" "if" "do" "stop" "list" "record" "get" "op"))
(defparameter *form-names* (append '("plan" "let" "for-each" "if" "do" "stop" "list" "record" "get") *json-operators*))

(defun name-atom-p (s)
  "A name as an atom: atom characters only, not a number, not starting with a digit."
  (and (plusp (length s)) (every #'atom-char-p s) (not (parse-number s)) (not (digit-char-p (char s 0)))))

(defun json-number-text-p (s)
  "-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][-+]?[0-9]+)?"
  (let ((i 0) (n (length s)))
    (flet ((digits () (let ((start i)) (loop while (and (< i n) (digit-char-p (char s i))) do (incf i)) (> i start))))
      (when (and (< i n) (char= (char s i) #\-)) (incf i))
      (and (< i n)
           (if (char= (char s i) #\0) (progn (incf i) t) (digits))
           (or (>= i n) (char/= (char s i) #\.) (progn (incf i) (digits)))
           (or (>= i n) (not (find (char s i) "eE"))
               (progn (incf i) (when (and (< i n) (find (char s i) "+-")) (incf i)) (digits)))
           (= i n)))))

(defun read-json (text)
  "TEXT as JSON with positions: (:object L C ((key kl kc value) ...)), (:array L C items),
(:string L C s), (:number L C text), (:literal L C \"true\"|\"false\"|\"null\"). Signals SYNTAX-ERROR."
  (let ((i 0) (n (length text)) (line 1) (col 1))
    (labels ((fail-at (code l c fmt &rest args)
               (error 'syntax-error :code code :line l :column c :message (apply #'format nil fmt args)))
             (fail (code fmt &rest args) (apply #'fail-at code line col fmt args))
             (peek () (and (< i n) (char text i)))
             (next () (let ((c (char text i))) (incf i) (if (char= c #\Newline) (setf line (1+ line) col 1) (incf col)) c))
             (ws () (loop while (and (peek) (space-char-p (peek))) do (next)))
             (end () (fail "unexpected-end" "the plan ended early; is a } or ] missing?"))
             (hex4 ()
               (let ((h 0))
                 (dotimes (k 4 h)
                   (let ((d (and (peek) (digit-char-p (peek) 16))))
                     (unless d (fail "bad-escape" "\\u needs four hex digits"))
                     (next) (setf h (+ (* 16 h) d))))))
             (str ()
               (let ((l line) (c col) (o (make-string-output-stream)))
                 (next)
                 (loop (let ((ch (peek)))
                         (cond ((null ch) (fail-at "unclosed-text" l c "this text is not closed"))
                               ((char= ch #\") (next) (return (get-output-stream-string o)))
                               ((< (char-code ch) 32) (fail "bad-json" "a control character must be escaped inside a JSON string"))
                               ((char/= ch #\\) (write-char (next) o))
                               (t (next)
                                  (let* ((e (peek))
                                         (simple (and e (cdr (assoc e '((#\" . #\") (#\\ . #\\) (#\/ . #\/) (#\b . #\Backspace)
                                                                         (#\f . #\Page) (#\n . #\Newline) (#\r . #\Return) (#\t . #\Tab)))))))
                                    (cond (simple (next) (write-char simple o))
                                          ((eql e #\u)
                                           (next)
                                           (let ((h (hex4)))
                                             ;; a surrogate pair is one code point
                                             (if (and (<= #xD800 h #xDBFF) (< (1+ i) n) (char= (char text i) #\\) (char= (char text (1+ i)) #\u))
                                                 (let ((save-i i) (save-col col))
                                                   (next) (next)
                                                   (let ((lo (hex4)))
                                                     (if (<= #xDC00 lo #xDFFF)
                                                         (write-char (code-char (+ #x10000 (ash (- h #xD800) 10) (- lo #xDC00))) o)
                                                         (progn (setf i save-i col save-col) (write-char (code-char h) o)))))
                                                 (write-char (code-char h) o))))
                                          (t (fail "bad-escape" "not a JSON escape"))))))))))
             (value (depth)
               (ws)
               (let ((l line) (c col) (ch (peek)))
                 (cond
                   ((null ch) (end))
                   ((and (find ch "{[") (>= depth *max-json-depth*)) (fail "too-deep" "JSON nested deeper than ~d" *max-json-depth*))
                   ((char= ch #\{)
                    (next) (ws)
                    (let ((entries '()))
                      (if (eql (peek) #\})
                          (next)
                          (loop
                            (ws)
                            (unless (peek) (end))
                            (unless (char= (peek) #\") (fail "bad-json" "a key in quotes was expected"))
                            (let* ((kl line) (kc col) (key (str)))
                              (when (find key entries :key #'first :test #'string=)
                                (fail-at "bad-json" kl kc "the key ~s appears twice" key))
                              (ws)
                              (unless (peek) (end))
                              (unless (char= (peek) #\:) (fail "bad-json" "':' was expected"))
                              (next)
                              (push (list key kl kc (value (1+ depth))) entries))
                            (ws)
                            (unless (peek) (end))
                            (cond ((char= (peek) #\,) (next))
                                  ((char= (peek) #\}) (next) (return))
                                  (t (fail "bad-json" "',' or '}' was expected")))))
                      (list :object l c (nreverse entries))))
                   ((char= ch #\[)
                    (next) (ws)
                    (let ((items '()))
                      (if (eql (peek) #\])
                          (next)
                          (loop
                            (push (value (1+ depth)) items)
                            (ws)
                            (unless (peek) (end))
                            (cond ((char= (peek) #\,) (next))
                                  ((char= (peek) #\]) (next) (return))
                                  (t (fail "bad-json" "',' or ']' was expected")))))
                      (list :array l c (nreverse items))))
                   ((char= ch #\") (list :string l c (str)))
                   (t
                    (dolist (w '("true" "false" "null"))
                      (when (and (<= (+ i (length w)) n) (string= w text :start2 i :end2 (+ i (length w))))
                        (dotimes (k (length w)) (next))
                        (return-from value (list :literal l c w))))
                    (let ((o (make-string-output-stream)))
                      (loop while (and (peek) (find (peek) "-+.eE0123456789")) do (write-char (next) o))
                      (let ((s (get-output-stream-string o)))
                        (unless (json-number-text-p s)
                          (if (plusp (length s))
                              (fail-at "bad-json" l c "~a is not a JSON number" s)
                              (fail-at "bad-json" l c "character ~s is not allowed here" ch)))
                        (list :number l c s))))))))
      (when (> n *max-length*) (fail-at "too-long" 1 1 "the plan is longer than ~d characters" *max-length*))
      (let ((root (value 0)))
        (ws)
        (when (peek) (fail "trailing-content" "there is content after the plan; a JSON plan is a single object"))
        root))))

(defun read-json-plan (text)
  "Reads a plan in the JSON syntax into the NODE tree of the s-expression it stands for."
  (let ((root (read-json text)) (tokens 0))
    (labels ((pos (j) (values (second j) (third j)))
             (count-token ()
               (when (> (incf tokens) *max-tokens*)
                 (error 'syntax-error :code "too-large" :line 1 :column 1
                                      :message (format nil "the plan has more than ~d tokens" *max-tokens*))))
             (bad-at (l c fmt &rest args)
               (error 'syntax-error :code "bad-form" :line l :column c :message (apply #'format nil fmt args)))
             (bad (j fmt &rest args) (apply #'bad-at (second j) (third j) fmt args))
             (lst (j items depth)
               (when (>= depth *max-depth*)
                 (error 'syntax-error :code "too-deep" :line (second j) :column (third j)
                                      :message (format nil "lists nested deeper than ~d" *max-depth*)))
               (count-token)
               (multiple-value-bind (l c) (pos j) (node :list items l c)))
             (name (j what)
               (unless (eq (first j) :string) (bad j "~a is a name in quotes" what))
               (unless (name-atom-p (fourth j))
                 (error 'syntax-error :code "bad-token" :line (second j) :column (third j)
                                      :message (format nil "~s is not a name" (fourth j))))
               (count-token)
               (node :name (fourth j) (second j) (third j) (fourth j)))
             (head (value entry) (count-token) (node :name value (second entry) (third entry) value))
             (entry (o key) (find key (fourth o) :key #'first :test #'string=))
             (keys (o required &optional optional)
               (dolist (e (fourth o))
                 (unless (member (first e) (append required optional) :test #'string=)
                   (bad-at (second e) (third e) "~s does not belong here; this object has ~{~s~^, ~}" (first e) (append required optional))))
               (dolist (k required)
                 (unless (entry o k) (bad o "this object needs ~s" k))))
             (val (o key) (fourth (entry o key)))
             (arr (j what)
               (cond ((null j) '())
                     ((eq (first j) :array) (fourth j))
                     (t (bad j "~a is a list [...]" what))))
             (pair (j depth)
               (unless (eq (first j) :object) (bad j "this is {\"name\": ..., \"value\": ...}"))
               (keys j '("name" "value"))
               (list (name (val j "name") "name") (expr (val j "value") depth)))
             (body (j depth) (mapcar (lambda (x) (expr x depth)) (arr j "body")))
             (expr (j depth)
               (ecase (first j)
                 (:string (count-token) (node :text (fourth j) (second j) (third j)))
                 (:number
                  (let ((v (parse-number (fourth j))))
                    (unless v
                      (error 'syntax-error :code "bad-token" :line (second j) :column (third j)
                                           :message (format nil "~a: a number is written with digits and at most one decimal point, no exponent" (fourth j))))
                    (count-token)
                    (node :number v (second j) (third j) (fourth j))))
                 (:literal (bad j "~a is not part of a plan; conditions are comparisons, and an absent value is left out" (fourth j)))
                 (:array (bad j "a list of values is {\"list\": [...]}"))
                 (:object
                  (let* ((form (or (find-if (lambda (k) (member k *json-expression-keys* :test #'string=)) (mapcar #'first (fourth j)))
                                   (first (first (fourth j)))))
                         (d (1+ depth)))
                    (cond
                      ((null form) (bad j "an empty object is not an expression"))
                      ((string= form "var") (keys j '("var")) (name (val j "var") "var"))
                      ((string= form "call")
                       (keys j '("call") '("args"))
                       (let ((op (name (val j "call") "call")))
                         (when (member (name-fold (node-value op)) *form-names* :test #'string=)
                           (bad (val j "call") "~a is not an operation; write it as {~s: ...}" (node-value op) (node-value op)))
                         (lst j (cons op (loop for a in (arr (val j "args") "args") append (pair a d))) depth)))
                      ((string= form "let")
                       (keys j '("let" "body"))
                       (lst j (list* (head "let" (entry j "let"))
                                     (lst (val j "let") (mapcar (lambda (b) (lst b (pair b (+ d 2)) (1+ d))) (arr (val j "let") "let")) d)
                                     (body (val j "body") d))
                            depth))
                      ((string= form "for_each")
                       (keys j '("for_each" "body"))
                       (lst j (list* (head "for-each" (entry j "for_each"))
                                     (lst (val j "for_each") (pair (val j "for_each") (1+ d)) d)
                                     (body (val j "body") d))
                            depth))
                      ((string= form "if")
                       (keys j '("if" "then") '("else"))
                       (let ((e (val j "else")))
                         (lst j (append (list (head "if" (entry j "if")) (expr (val j "if") d) (expr (val j "then") d))
                                        (and e (not (and (eq (first e) :literal) (string= (fourth e) "null"))) (list (expr e d))))
                              depth)))
                      ((member form '("do" "stop" "list") :test #'string=)
                       (keys j (list form))
                       (lst j (cons (head form (entry j form)) (mapcar (lambda (x) (expr x d)) (arr (val j form) form))) depth))
                      ((string= form "record")
                       (keys j '("record"))
                       (lst j (cons (head "record" (entry j "record")) (loop for f in (arr (val j "record") "record") append (pair f d))) depth))
                      ((string= form "get")
                       (keys j '("get" "field"))
                       (lst j (list (head "get" (entry j "get")) (expr (val j "get") d) (name (val j "field") "field")) depth))
                      ((string= form "op")
                       (keys j '("op" "args"))
                       (let ((op (val j "op")))
                         (unless (and (eq (first op) :string) (member (fourth op) *json-operators* :test #'string=))
                           (bad op "op is one of ~{~a~^ ~}" *json-operators*))
                         (lst j (cons (head (fourth op) op) (mapcar (lambda (x) (expr x d)) (arr (val j "args") "args"))) depth)))
                      (t (bad j "~s is not an expression; an object starts with one of ~{~s~^, ~}" form *json-expression-keys*))))))))
      (unless (and (eq (first root) :object) (entry root "plan"))
        (bad root "a JSON plan is {\"plan\": \"title\", \"body\": [...]}"))
      (keys root '("plan" "body"))
      (let ((title (val root "plan")))
        (unless (eq (first title) :string) (bad title "the plan's title is a text"))
        (count-token) (count-token) (count-token)
        (node :list (list* (node :name "plan" (second (entry root "plan")) (third (entry root "plan")) "plan")
                           (node :text (fourth title) (second title) (third title))
                           (body (val root "body") 1))
              (second root) (third root))))))

;;; ------------------------------------------------------------------
;;; Operations (SPEC 6). Types: :text :number :bool :any (:list T) (:record (name . T) ...)
;;; ------------------------------------------------------------------

(defstruct (operation (:conc-name op-)) name effect params returns key
  label)   ; what its results are labelled with (SPEC 5.2): their source is tool:LABEL
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
          ((and (member ty '("text" "number") :test #'equal) (gethash "enum" j))
           (list :enum (intern (string-upcase ty) :keyword) (coerce (gethash "enum" j) 'list)))
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
    (when (and (gethash "label" j) (not (label-p (gethash "label" j))))
      (error "bad label ~s in operation ~a: lowercase letters, digits, _ and -" (gethash "label" j) name))
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
                          :returns (type-from-json (gethash "returns" j))
                          :key (and (gethash "key" j) (coerce (gethash "key" j) 'list))
                          :label (gethash "label" j)))))

(defun lisp-type (spec)
  (cond ((member spec '(:text :number :bool :any)) spec)
        ((eq (first spec) :enum) (list :enum (second spec) (third spec)))
        ((eq (first spec) :list) (list :list (lisp-type (second spec))))
        ((eq (first spec) :record)
         (cons :record (sort (mapcar (lambda (f) (cons (name-fold (string-downcase (string (first f))))
                                                       (lisp-type (second f))))
                                     (rest spec))
                             #'string< :key #'car)))
        (t (error "unknown type ~s" spec))))

(defmacro define-operation (name (&key (effect "write") (returns :any) key) &rest params)
  "Lisp-side declaration: (define-operation erp.stock (:effect :read :returns (:list ...)) (product :text :required nil))"
  `(setf (gethash (name-fold ,(string-downcase (string name))) *operations*)
         (make-operation :name ,(string-downcase (string name)) :effect ,(string-downcase (string effect)) :returns (lisp-type ',returns)
                         :key ',(mapcar (lambda (k) (string-downcase (string k))) key)
                         :params (list ,@(mapcar (lambda (p)
                                                   (destructuring-bind (pn ty &key (required t) model-allowed) p
                                                     `(make-param :name ,(string-downcase (string pn)) :type (lisp-type ',ty)
                                                                  :required ,required :model-allowed ,model-allowed)))
                                                 params)))))

;;; ------------------------------------------------------------------
;;; Policy (SPEC 12)
;;; ------------------------------------------------------------------

(defstruct (actor (:conc-name actor-)) id roles)

(defstruct (rule (:conc-name rule-))
  name operations effects actor-roles actor-not-roles
  args        ; ((param op value) ...)  — conditions on argument values
  decision    ; (:deny reason) | (:approve role four-eyes) | (:args-from ...)
  total       ; ((param op value) ...)  — the sum of PARAM over the steps the rule selects (SPEC 12.3)
  count)      ; ((op value) ...)        — how many steps it selects   ; (:deny reason) | (:approve role four-eyes) | (:args-from ((param . (source ...)) ...))

(defvar *policy* '() "The rules in force (a list of RULE).")
(defvar *actor* nil "Who asked for the plan (an ACTOR), or NIL.")

(defparameter *condition-ops* '("=" "!=" "<" "<=" ">" ">=" "in" "not_in"))
(defparameter *order-ops* '("<" "<=" ">" ">="))

(defun plan-rule-p (rule)
  "A rule on the whole plan (SPEC 12.3): decided once the plan's steps are known."
  (or (rule-total rule) (rule-count rule)))
(defparameter *source-names* '(("message" . :message) ("tool" . :tool) ("model" . :model) ("schema" . :schema)))

(defun label-p (x)
  "A label: [a-z][a-z0-9_-]*."
  (and (stringp x) (plusp (length x)) (lower-letter-p (char x 0))
       (every (lambda (c) (or (lower-letter-p c) (char<= (code-char 48) c (code-char 57)) (find c "_-"))) x)))

(defun labelled-source (label)
  "The source of a labelled operation's results, tool:LABEL, as a keyword (labels come from declarations, never from plans)."
  (intern (format nil "tool:~a" label) :keyword))

(defun source-keyword (name)
  (or (cdr (assoc name *source-names* :test #'string=))
      (and (stringp name) (> (length name) 5) (string= "tool:" name :end2 5) (label-p (subseq name 5))
           (labelled-source (subseq name 5)))))

(defun source-allowed-p (source allowed)
  "A value from SOURCE may go where ALLOWED is required: tool admits every tool, labelled or not."
  (or (member source allowed)
      (and (not (member source '(:message :tool :model :schema))) (member :tool allowed))))

(defun as-list (x)
  (cond ((null x) nil) ((stringp x) (list x)) ((vectorp x) (coerce x 'list)) (t x)))

(defun policy-error (fmt &rest args) (error "policy: ~?" fmt args))

(defun actor-from-json (j)
  (and (hash-table-p j) (make-actor :id (gethash "id" j) :roles (as-list (gethash "roles" j)))))

(defun policy-from-json (j)
  "Rules from {\"rules\": [...]} or a bare array. Signals an error on anything it does not understand."
  (let ((rules (if (hash-table-p j) (gethash "rules" j) j)))
    (loop for r across (or rules #())
          collect
          (let* ((w (or (gethash "when" r) (make-hash-table :test #'equal)))
                 (then (gethash "then" r))
                 (name (or (gethash "name" r) "unnamed rule"))
                 (args (let ((a (gethash "args" w)) (out '()))
                         (when a
                           (maphash (lambda (param conds)
                                      (maphash (lambda (cop value)
                                                 (unless (member cop *condition-ops* :test #'string=)
                                                   (policy-error "~a: unknown comparison ~s" name cop))
                                                 (push (list param cop (if (and (vectorp value) (not (stringp value))) (coerce value 'list) value)) out))
                                               conds))
                                    a))
                         out))
                 (total (let ((tt (gethash "total" w)) (out '()))
                          (when tt
                            (unless (hash-table-p tt) (policy-error "~a: total must be an object, {\"param\": {\"OP\": NUMBER}}" name))
                            (maphash (lambda (param conds)
                                       (unless (hash-table-p conds) (policy-error "~a: conditions on the total of ~a must be an object" name param))
                                       (maphash (lambda (cop value)
                                                  (unless (and (member cop *order-ops* :test #'string=) (rationalp value))
                                                    (policy-error "~a: a total is compared with <, <=, > or >= and a number" name))
                                                  (push (list param cop value) out))
                                                conds))
                                     tt))
                          out))
                 (count (let ((cc (gethash "count" w)) (out '()))
                          (when cc
                            (unless (hash-table-p cc) (policy-error "~a: count must be an object, {\"OP\": NUMBER}" name))
                            (maphash (lambda (cop value)
                                       (unless (and (member cop *order-ops* :test #'string=) (rationalp value))
                                         (policy-error "~a: a count is compared with <, <=, > or >= and a number" name))
                                       (push (list cop value) out))
                                     cc))
                          out))
                 (decision
                   (cond ((equal then "deny") (list :deny nil))
                         ((and (hash-table-p then) (gethash "deny" then)) (list :deny (gethash "deny" then)))
                         ((and (hash-table-p then) (gethash "approve_by" then))
                          (list :approve (gethash "approve_by" then) (eq (gethash "four_eyes" then) :true)))
                         ((and (hash-table-p then) (gethash "args_from" then))
                          (when (or args total count) (policy-error "~a: args_from is decided from the plan's text; it cannot depend on argument values" name))
                          (list :args-from
                                (loop for param being the hash-keys of (gethash "args_from" then) using (hash-value srcs)
                                      collect (cons param (mapcar (lambda (x) (or (source-keyword x)
                                                                                 (policy-error "~a: unknown source ~s" name x)))
                                                                  (as-list srcs))))))
                         (t (policy-error "~a: then must be \"deny\", {\"deny\": ...}, {\"approve_by\": ...} or {\"args_from\": ...}" name)))))
            (make-rule :name name
                       :operations (mapcar #'name-fold (as-list (gethash "operation" w)))
                       :effects (as-list (gethash "effect" w))
                       :actor-roles (as-list (gethash "actor_role" w))
                       :actor-not-roles (as-list (gethash "actor_not_role" w))
                       :args args :decision decision :total total :count count)))))

(defun has-any-role-p (roles)
  (and *actor* (intersection roles (actor-roles *actor*) :test #'string=) t))

(defun rule-concerns-p (rule op)
  "The rule's operation, effect and actor conditions hold (argument conditions aside)."
  (and (or (null (rule-operations rule)) (member (name-fold (op-name op)) (rule-operations rule) :test #'string=))
       (or (null (rule-effects rule)) (member (op-effect op) (rule-effects rule) :test #'string=))
       (or (null (rule-actor-roles rule)) (has-any-role-p (rule-actor-roles rule)))
       (or (null (rule-actor-not-roles rule)) (not (has-any-role-p (rule-actor-not-roles rule))))))

(defun policy-equal-p (a b)
  (cond ((and (stringp a) (stringp b)) (string= (fold a) (fold b)))
        ((and (rationalp a) (rationalp b)) (= a b))
        (t (equal a b))))

(defun condition-holds-p (cop actual expected)
  "ACTUAL :unknown (a value not known yet) satisfies every condition: the rule is assumed to apply."
  (cond ((eq actual :unknown) t)
        ((eq actual :absent) nil)
        ((string= cop "=") (policy-equal-p actual expected))
        ((string= cop "!=") (not (policy-equal-p actual expected)))
        ((string= cop "in") (and (member actual (as-list expected) :test #'policy-equal-p) t))
        ((string= cop "not_in") (not (member actual (as-list expected) :test #'policy-equal-p)))
        ((and (rationalp actual) (rationalp expected))
         (funcall (cdr (assoc cop '(("<" . <) ("<=" . <=) (">" . >) (">=" . >=)) :test #'string=)) actual expected))
        (t nil)))

(defun rule-args-match-p (rule args)
  "ARGS: ((param . value) ...); a parameter not given is :absent."
  (every (lambda (c)
           (destructuring-bind (param cop expected) c
             (let ((a (assoc (name-fold param) args :key #'name-fold :test #'string=)))
               (condition-holds-p cop (if a (cdr a) :absent) expected))))
         (rule-args rule)))

(defun source-names (sources)
  (mapcar (lambda (k) (or (car (rassoc k *source-names*)) (symbol-name k))) sources))

(defun check-policy (node op given given-nodes)
  "Rules that do not depend on argument values are decided here, from the plan's text."
  (dolist (r *policy*)
    (when (and (null (rule-args r)) (not (plan-rule-p r)) (rule-concerns-p r op))
      (case (first (rule-decision r))
        (:deny (err node "policy-denied" "~a is not allowed here (rule \"~a\")~@[: ~a~]"
                    (op-name op) (rule-name r) (second (rule-decision r))))
        (:args-from
         (loop for (param . allowed) in (second (rule-decision r))
               for k = (name-fold param)
               for v = (cdr (assoc k given :test #'string=))
               for bad = (and v (remove-if (lambda (s) (source-allowed-p s allowed)) (v-sources v)))
               when bad
                 do (err (cdr (assoc k given-nodes :test #'string=)) "policy-source"
                         "parameter ~a of ~a must come from ~{~a~^ or ~} (rule \"~a\"); this value comes from ~{~a~^ and ~}"
                         param (op-name op) (source-names allowed) (rule-name r) (source-names (v-sources v)))))))))

;;; ------------------------------------------------------------------
;;; Provenance helpers (SPEC 5.1)
;;; ------------------------------------------------------------------

(defun digit-readings (run)
  "The values a run like 1.250,50 may mean (SPEC 5.1)."
  (let ((out '()))
    (dolist (r (list (and (every #'digit-char-p run) run)
                     (let ((r (remove #\. run))) (and (<= (count #\, r) 1) (substitute #\. #\, r)))
                     (let ((r (remove #\, run))) (and (<= (count #\. r) 1) r))
                     (remove-if-not #'digit-char-p run)))
      (let ((v (and r (parse-number r))))
        (when v (pushnew v out))))
    (nreverse out)))

(defun message-numbers (message &optional profile)
  "The message numbers: from digits, and with a language PROFILE from number words too (SPEC 5.4)."
  (let ((out '()) (i 0) (n (length message)))
    (flet ((digit (k) (and (< -1 k n) (char<= #\0 (char message k) #\9))))
      (loop while (< i n)
            do (if (digit i)
                   (let ((start i))
                     (loop while (and (< i n) (or (digit i) (and (find (char message i) ".,") (digit (1+ i)))))
                           do (incf i))
                     (dolist (v (digit-readings (subseq message start i))) (pushnew v out)))
                   (incf i))))
    (when profile
      (dolist (v (profile-numbers message profile)) (pushnew v out)))
    out))

;;; --- Language profiles (SPEC 5.4): number words, from data in profiles/*.json

(defvar *profile* nil "The language profile in force, or NIL.")

(defstruct profile language (units (make-hash-table :test #'equal)) hundred (scales (make-hash-table :test #'equal)) joiners compound)

(defun profile-lower (s)
  "NFC, each code point lowercased (full mapping: İ gives i and U+0307), U+0307 removed. Marks stay: ö is not o."
  (remove (code-char #x307)
          (apply #'concatenate 'string
                 (map 'list (lambda (c) (sb-unicode:lowercase (string c))) (sb-unicode:normalize-string s :nfc)))))

(defun profile-from-json (j)
  (let ((n (and (hash-table-p j) (gethash "numbers" j))))
    (unless (and (stringp (gethash "language" j)) (hash-table-p n) (hash-table-p (gethash "units" n)))
      (error "a profile is {\"language\": ..., \"numbers\": {\"units\": {...}, ...}}"))
    (let ((p (make-profile :language (gethash "language" j) :compound (eq (gethash "compound" n) :true))))
      (flet ((word (w)
               (unless (and (stringp w) (plusp (length w)) (string= w (profile-lower w)) (every #'alpha-char-p w))
                 (error "profile ~a: ~s is not a lowercase word" (profile-language p) w))
               w)
             (int (w v)
               (unless (and (integerp v) (>= v 0)) (error "profile ~a: ~a is not a whole number" (profile-language p) w))
               v))
        (maphash (lambda (w v) (setf (gethash (word w) (profile-units p)) (int w v))) (gethash "units" n))
        (setf (profile-hundred p) (map 'list #'word (or (gethash "hundred" n) #()))
              (profile-joiners p) (map 'list #'word (or (gethash "joiners" n) #())))
        (when (hash-table-p (gethash "scales" n))
          (maphash (lambda (w v) (setf (gethash (word w) (profile-scales p)) (int w v))) (gethash "scales" n))))
      p)))

(defun profile-item (p w)
  (cond ((gethash w (profile-units p)) (cons :unit (gethash w (profile-units p))))
        ((member w (profile-hundred p) :test #'string=) (cons :hundred 100))
        ((gethash w (profile-scales p)) (cons :scale (gethash w (profile-scales p))))))

(defun profile-items (p w)
  "W as number words: itself, or (compound profiles) split into them, longest first; NIL if not."
  (let ((one (profile-item p w)))
    (cond (one (list one))
          ((not (profile-compound p)) nil)
          (t (let ((vocab (sort (append (loop for k being the hash-keys of (profile-units p) collect k)
                                        (copy-list (profile-hundred p))
                                        (loop for k being the hash-keys of (profile-scales p) collect k))
                                #'> :key #'length)))
               (labels ((split (rest)
                          (if (zerop (length rest))
                              (values '() t)
                              (dolist (v vocab (values nil nil))
                                (when (and (<= (length v) (length rest)) (string= v rest :end2 (length v)))
                                  (multiple-value-bind (tail ok) (split (subseq rest (length v)))
                                    (when ok (return (values (cons (profile-item p v) tail) t)))))))))
                 (multiple-value-bind (items ok) (split w) (and ok items))))))))

(defun profile-numbers (message p)
  "The numbers the profile P reads in MESSAGE (besides its digits)."
  (let* ((text (profile-lower message)) (n (length text)) (i 0) (gap-ok t) (tokens '()))
    ;; tokens: (word digits joined), joined = only white space or hyphens since the previous token
    (flet ((digit (k) (and (< -1 k n) (char<= #\0 (char text k) #\9))))
      (loop while (< i n)
            do (let ((c (char text i)))
                 (cond ((alpha-char-p c)
                        (let ((start i))
                          (loop while (and (< i n) (alpha-char-p (char text i))) do (incf i))
                          (push (list (subseq text start i) nil gap-ok) tokens) (setf gap-ok t)))
                       ((digit i)
                        (let ((start i))
                          (loop while (and (< i n) (or (digit i) (and (find (char text i) ".,") (digit (1+ i))))) do (incf i))
                          (push (list nil (subseq text start i) gap-ok) tokens) (setf gap-ok t)))
                       (t (unless (or (char= c #\-) (sb-unicode:whitespace-p c)) (setf gap-ok nil))
                          (incf i))))))
    (setf tokens (coerce (nreverse tokens) 'vector))
    (let ((out '()) (started nil) (total 0) (group 0) (last-scale nil) (prev nil))
      (labels ((emit ()
                 (when started (pushnew (+ total group) out))
                 (setf started nil total 0 group 0 last-scale nil prev nil))
               (take (it)
                 (destructuring-bind (kind . v) it
                   (ecase kind
                     (:unit
                      (let ((k (cond ((zerop v) :zero) ((and (<= 10 v 90) (zerop (mod v 10))) :tens) (t :small))))
                        (unless (or (not started) (member prev '(:hundred :scale)) (and (eq prev :tens) (eq k :small) (< v 10)))
                          (emit))
                        (incf group v) (setf prev k started t)))
                     (:hundred
                      (unless (or (not started) (and (eq prev :small) (< 0 group 100)) (eq prev :scale))
                        (emit))
                      (setf group (* (if (zerop group) 1 group) 100) prev :hundred started t))
                     (:scale
                      (unless (or (not started) (and (plusp group) (or (null last-scale) (< v last-scale))))
                        (emit))
                      (incf total (* (if (zerop group) 1 group) v))
                      (setf group 0 last-scale v prev :scale started t))))))
        (loop with k = 0
              while (< k (length tokens))
              do (destructuring-bind (word digits joined) (aref tokens k)
                   (unless joined (emit))
                   (cond
                     (digits
                      (emit)
                      ;; "2 bin", "2,5 milyon": the digits' readings times the scale that follows
                      (let* ((next (and (< (1+ k) (length tokens)) (aref tokens (1+ k))))
                             (s (and next (first next) (third next) (gethash (first next) (profile-scales p)))))
                        (when s
                          (dolist (r (digit-readings digits)) (pushnew (* r s) out))
                          (incf k))))
                     ((member word (profile-joiners p) :test #'string=)
                      (let ((next (and (< (1+ k) (length tokens)) (aref tokens (1+ k)))))
                        (unless (and started next (first next) (third next) (profile-items p (first next)))
                          (emit))))
                     (t (let ((items (profile-items p word)))
                          (if items (mapc #'take items) (emit))))))
                 (incf k))
        (emit))
      (nreverse out))))

(defun text-in-message-p (literal message)
  (let ((f (fold (string-trim '(#\Space #\Tab #\Newline #\Return) literal)))
        (m (fold message)))
    (and (>= (length f) 2)
         (loop for start = 0 then (1+ pos)
               for pos = (search f m :start2 start)
               while pos
               thereis (or (zerop pos) (not (alphanumericp (char m (1- pos)))))))))

(defun number-in-message-p (value message)
  (and (>= value 0) (member value (message-numbers message *profile*) :test #'=)))

;;; ------------------------------------------------------------------
;;; Checker
;;; ------------------------------------------------------------------

(defstruct (val (:conc-name v-))
  (type :any)   ; :text :number :bool :list :record :none :any :error
  item          ; :list -> element VAL
  fields        ; :record -> ((name . VAL) ...)
  length        ; known list length
  sources       ; (:message :tool :model :schema)
  invented      ; literal NODEs not in the message
  allowed)      ; a tool's field declared with an enum: its values (schema constants)

(defstruct (call (:conc-name call-)) operation line column max-count conditional
  sources)   ; ((param . (source-name ...)) ...): where each argument comes from, for the preview
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

(defun val-of-type (type &optional (source :tool))
  "Value returned by an operation: everything in it comes from the tool (tool:LABEL for a labelled one)."
  (let ((s (list source)))
    (cond ((keywordp type) (make-val :type type :sources s))
          ((eq (first type) :enum) (make-val :type (second type) :sources s :allowed (third type)))
          ((eq (first type) :list) (make-val :type :list :sources s :item (val-of-type (second type) source)))
          (t (make-val :type :record :sources s
                       :fields (mapcar (lambda (f) (cons (car f) (val-of-type (cdr f) source))) (rest type)))))))

(defun fits-p (type v)
  (let ((g (v-type v)))
    (or (member g '(:error :any))
        (eq type :any)
        (if (keywordp type)
            (eq g type)
            (case (first type)
              (:enum (fits-p (second type) v))
              (:list (and (eq g :list) (or (null (v-item v)) (fits-p (second type) (v-item v)))))
              (:record (and (eq g :record)
                            (every (lambda (f) (let ((x (assoc (car f) (v-fields v) :test #'string=)))
                                                 (and x (fits-p (cdr f) (cdr x)))))
                                   (rest type)))))))))

(defun type-name (type)
  (cond ((keywordp type) (string-downcase (symbol-name type)))
        ((eq (first type) :enum) (format nil "~a, one of ~{~a~^, ~}" (type-name (second type))
                                         (mapcar (lambda (x) (if (stringp x) (format nil "~s" x) x)) (third type))))
        ((eq (first type) :list) (format nil "list of ~a" (type-name (second type))))
        (t (format nil "record (~{~a~^, ~})" (mapcar #'car (rest type))))))

(defun constant-allowed-p (node v)
  "SPEC 5.1: the literal NODE is one of the values declared for V, a tool's enum field."
  (and (member (node-kind node) '(:text :number))
       (v-allowed v)
       (member (node-value node) (v-allowed v)
               :test (lambda (x y) (if (and (stringp x) (stringp y))
                                       (string= (fold x) (fold y))
                                       (and (rationalp x) (rationalp y) (= x y)))))))

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
              ;; Schema constants: comparing a declared field with one of its declared values asks a
              ;; question about the tool's data; it does not make anything up.
              (when (and (form-is k "=" "!=") (= (length args) 2))
                (loop for i from 0 to 1
                      for a = (nth i args) and other = (nth (- 1 i) vs)
                      when (and (v-invented (nth i vs)) (constant-allowed-p a other))
                        do (setf (nth i vs) (make-val :type (v-type (nth i vs)) :sources (list :schema)))))
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
  (let ((given '()) (given-nodes '())
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
                       (push (cons k pv) given-nodes)
                       (want pv v (pa-type p))
                       (when (and side-effect (not (pa-model-allowed p)))
                         (dolist (lit (v-invented v))
                           (err lit "invented-value"
                                "~a is not in the message; a value the model wrote cannot go to parameter ~a of ~a, directly or through the result of a read that looked it up. Use the value from the message or from a read operation; if it is unknown, ask the user with (stop \"...\")."
                                (literal-text lit) (pa-name p) (op-name op)))))))))))
    (dolist (p params)
      (when (and (pa-required p) (not (assoc (name-fold (pa-name p)) given :test #'string=)))
        (err node "missing-parameter" "~a needs parameter ~a" (op-name op) (pa-name p))))
    (when (and side-effect *condition* (v-invented *condition*))
      (err node "invented-condition"
           "~a depends on a condition with ~{~a~^, ~}, which is not in the message: an operation that changes something cannot depend on a value the model made up"
           (op-name op) (mapcar #'literal-text (v-invented *condition*))))
    (check-policy node op given given-nodes)
    (push (make-call :operation op :line (node-line node) :column (node-column node) :max-count *multiplier* :conditional *conditional*
                     :sources (loop for (k . v) in given
                                    collect (cons (pa-name (find k params :key (lambda (x) (name-fold (pa-name x))) :test #'string=))
                                                  (sort (remove-duplicates (source-names (v-sources v)) :test #'string=) #'string<))))
          *calls*)
    ;; SPEC 5.2: what an operation returns depends on what it was asked. Its result carries the
    ;; invented literals of its arguments (except model_allowed ones): looking up a customer, a
    ;; server or an invoice the model made up does not turn the answer into trusted data.
    (let ((inherited (remove-duplicates
                      (loop for p in params
                            for v = (cdr (assoc (name-fold (pa-name p)) given :test #'string=))
                            when (and v (not (pa-model-allowed p))) append (v-invented v)))))
      (taint (val-of-type (op-returns op) (if (op-label op) (labelled-source (op-label op)) :tool)) inherited))))

(defun taint (v literals)
  "V and every part of it also carry LITERALS (invented) and so the source model."
  (when literals
    (setf (v-invented v) (remove-duplicates (append (v-invented v) literals))
          (v-sources v) (adjoin :model (v-sources v)))
    (when (v-item v) (taint (v-item v) literals))
    (dolist (f (v-fields v)) (taint (cdr f) literals)))
  v)

(defun sort-errors (errors)
  (stable-sort (remove-duplicates (reverse errors)
                                  :test (lambda (a b) (and (string= (soz-error-code a) (soz-error-code b))
                                                           (= (soz-error-line a) (soz-error-line b))
                                                           (= (soz-error-column a) (soz-error-column b))))
                                  :from-end t)
               (lambda (a b) (or (< (soz-error-line a) (soz-error-line b))
                                 (and (= (soz-error-line a) (soz-error-line b))
                                      (< (soz-error-column a) (soz-error-column b)))))))

(defun check-plan (text &key message (policy *policy*) (actor *actor*) (profile *profile*))
  "Checks the plan in TEXT against MESSAGE (what the user wrote, or NIL), under POLICY for ACTOR.
Runs nothing. Returns a RESULT."
  (let ((*errors* (quote ())) (*message* message) (*multiplier* 1) (*condition* nil) (*policy* policy) (*actor* actor) (*profile* profile)
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
