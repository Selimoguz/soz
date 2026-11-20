;;;; run.lisp — soz 0.2: preview (dry run), approval, execution, journal and audit record (SPEC 10).
;;;; Load after json.lisp and soz.lisp.

(in-package :soz)

(export '(preview execute define-implementation *implementations* operation-failed operation-unknown
          preview-status preview-steps preview-problems preview-stop-reason preview-hash preview-json
          execution-outcome execution-steps execution-message execution-stop-reason execution-json
          make-journal journal-entries make-audit open-audit audit-path audit-lines verify-audit sha256-hex canonical-json
          step-index step-operation step-args step-key step-already-done step-status step-requires preview-summary
          open-journal preview-actor))

;;; ------------------------------------------------------------------
;;; SHA-256 (FIPS 180-4)
;;; ------------------------------------------------------------------

(defparameter +sha-k+
  (coerce '(#x428a2f98 #x71374491 #xb5c0fbcf #xe9b5dba5 #x3956c25b #x59f111f1 #x923f82a4 #xab1c5ed5
            #xd807aa98 #x12835b01 #x243185be #x550c7dc3 #x72be5d74 #x80deb1fe #x9bdc06a7 #xc19bf174
            #xe49b69c1 #xefbe4786 #x0fc19dc6 #x240ca1cc #x2de92c6f #x4a7484aa #x5cb0a9dc #x76f988da
            #x983e5152 #xa831c66d #xb00327c8 #xbf597fc7 #xc6e00bf3 #xd5a79147 #x06ca6351 #x14292967
            #x27b70a85 #x2e1b2138 #x4d2c6dfc #x53380d13 #x650a7354 #x766a0abb #x81c2c92e #x92722c85
            #xa2bfe8a1 #xa81a664b #xc24b8b70 #xc76c51a3 #xd192e819 #xd6990624 #xf40e3585 #x106aa070
            #x19a4c116 #x1e376c08 #x2748774c #x34b0bcb5 #x391c0cb3 #x4ed8aa4a #x5b9cca4f #x682e6ff3
            #x748f82ee #x78a5636f #x84c87814 #x8cc70208 #x90befffa #xa4506ceb #xbef9a3f7 #xc67178f2)
          'vector))

(defun sha256-hex (text)
  "SHA-256 of TEXT encoded as UTF-8, lower-case hex."
  (let* ((bytes (sb-ext:string-to-octets text :external-format :utf-8))
         (len (length bytes))
         (total (* 64 (ceiling (+ len 9) 64)))
         (m (make-array total :element-type '(unsigned-byte 8) :initial-element 0))
         (h (vector #x6a09e667 #xbb67ae85 #x3c6ef372 #xa54ff53a #x510e527f #x9b05688c #x1f83d9ab #x5be0cd19))
         (w (make-array 64)))
    (replace m bytes)
    (setf (aref m len) #x80)
    (loop for i from 0 below 8
          do (setf (aref m (- total 1 i)) (ldb (byte 8 (* 8 i)) (* 8 len))))
    (flet ((rotr (x n) (logand #xffffffff (logior (ash x (- n)) (ash x (- 32 n)))))
           (add (&rest xs) (logand #xffffffff (apply #'+ xs))))
      (loop for chunk from 0 below total by 64
            do (loop for i below 16
                     do (setf (aref w i) (logior (ash (aref m (+ chunk (* 4 i))) 24) (ash (aref m (+ chunk (* 4 i) 1)) 16)
                                                 (ash (aref m (+ chunk (* 4 i) 2)) 8) (aref m (+ chunk (* 4 i) 3)))))
               (loop for i from 16 below 64
                     do (let* ((w15 (aref w (- i 15))) (w2 (aref w (- i 2)))
                               (s0 (logxor (rotr w15 7) (rotr w15 18) (ash w15 -3)))
                               (s1 (logxor (rotr w2 17) (rotr w2 19) (ash w2 -10))))
                          (setf (aref w i) (add (aref w (- i 16)) s0 (aref w (- i 7)) s1))))
               (let ((a (aref h 0)) (b (aref h 1)) (c (aref h 2)) (d (aref h 3))
                     (e (aref h 4)) (f (aref h 5)) (g (aref h 6)) (hh (aref h 7)))
                 (loop for i below 64
                       do (let* ((s1 (logxor (rotr e 6) (rotr e 11) (rotr e 25)))
                                 (ch (logxor (logand e f) (logand (logxor e #xffffffff) g)))
                                 (t1 (add hh s1 ch (aref +sha-k+ i) (aref w i)))
                                 (s0 (logxor (rotr a 2) (rotr a 13) (rotr a 22)))
                                 (maj (logxor (logand a b) (logand a c) (logand b c)))
                                 (t2 (add s0 maj)))
                            (setf hh g g f f e e (add d t1) d c c b b a a (add t1 t2))))
                 (loop for v in (list a b c d e f g hh) for i from 0
                       do (setf (aref h i) (add (aref h i) v))))))
    (format nil "~(~{~8,'0x~}~)" (coerce h 'list))))

;;; ------------------------------------------------------------------
;;; Run-time values
;;;   text: string    number: rational    bool: :true / :false    none: :none
;;;   list: (:list . items)    record: (:record . ((name . value) ...)) sorted by name
;;;   pending: PENDING struct (the result of a step not run yet, in a preview)
;;; ------------------------------------------------------------------

(defstruct pending step path)

(defun rec (alist) (cons :record (sort (copy-list alist) #'string< :key #'car)))
(defun rec-p (v) (and (consp v) (eq (car v) :record)))
(defun lst-p (v) (and (consp v) (eq (car v) :list)))

(defun decimal-text (r)
  "Exact decimal without exponent or trailing zeros, or NIL if R has no finite decimal."
  (let ((d (denominator r)) (k 0))
    (loop while (zerop (mod d 2)) do (setf d (/ d 2)) (incf k))
    (let ((j 0)) (loop while (zerop (mod d 5)) do (setf d (/ d 5)) (incf j)) (setf k (max k j)))
    (when (= d 1)
      (if (zerop k)
          (format nil "~d" r)
          (let* ((scaled (abs (* r (expt 10 k))))
                 (s (format nil "~v,'0d" (1+ k) scaled))
                 (int (subseq s 0 (- (length s) k)))
                 (frac (string-right-trim "0" (subseq s (- (length s) k)))))
            (format nil "~:[~;-~]~a~:[.~a~;~]" (minusp r) int (zerop (length frac)) frac))))))

(defun number-text (r) (or (decimal-text r) (format nil "~d/~d" (numerator r) (denominator r))))

(defun json-string (s out)
  (write-char #\" out)
  (loop for c across s
        do (cond ((char= c #\") (write-string "\\\"" out))
                 ((char= c #\\) (write-string "\\\\" out))
                 ((< (char-code c) 32) (format out "\\u~(~4,'0x~)" (char-code c)))
                 (t (write-char c out))))
  (write-char #\" out))

(defun canonical-json (v)
  "SPEC 10.6. V: run-time value, hash table, vector, list of (key . value) via :object, string, number, keyword."
  (with-output-to-string (out)
    (labels ((obj (pairs)
               (write-char #\{ out)
               (loop for (k . x) in (sort (copy-list pairs) #'string< :key #'car) for first = t then nil
                     do (unless first (write-char #\, out)) (json-string k out) (write-char #\: out) (w x))
               (write-char #\} out))
             (w (x)
               (cond ((stringp x) (json-string x out))
                     ((rationalp x) (let ((d (decimal-text x))) (if d (write-string d out) (json-string (number-text x) out))))
                     ((floatp x) (w (rational x)))
                     ((member x '(:true t)) (write-string "true" out))
                     ((member x '(:false)) (write-string "false" out))
                     ((member x '(:null :none nil)) (write-string "null" out))
                     ((pending-p x) (obj (append (list (cons "pending" (pending-step x)))
                                                 (when (pending-path x) (list (cons "path" (coerce (pending-path x) 'vector)))))))
                     ((rec-p x) (obj (cdr x)))
                     ((lst-p x) (w (coerce (cdr x) 'vector)))
                     ((and (consp x) (eq (car x) :object)) (obj (cdr x)))
                     ((hash-table-p x) (obj (loop for k being the hash-keys of x using (hash-value y) collect (cons k y))))
                     ((vectorp x) (write-char #\[ out)
                      (loop for y across x for first = t then nil do (unless first (write-char #\, out)) (w y))
                      (write-char #\] out))
                     (t (error "cannot write ~s as JSON" x)))))
      (w v))))

(defun obj (&rest kv) (cons :object (loop for (k v) on kv by #'cddr collect (cons k v))))

(defun value-text (v)
  "A value as people read it (stop reasons, previews)."
  (cond ((stringp v) v)
        ((rationalp v) (number-text v))
        ((eq v :true) "true") ((eq v :false) "false") ((eq v :none) "nothing")
        ((pending-p v) (format nil "(result of step ~d)~{.~a~}" (pending-step v) (pending-path v)))
        (t (canonical-json v))))

;;; ------------------------------------------------------------------
;;; Implementations and their results
;;; ------------------------------------------------------------------

(defvar *implementations* (make-hash-table :test #'equal) "name-fold -> function of an args hash table")

(define-condition operation-failed (error) ((message :initarg :message :initform "" :reader outcome-message)))
(define-condition operation-unknown (error) ((message :initarg :message :initform "" :reader outcome-message)))

(defmacro define-implementation (name (args) &body body)
  "(define-implementation erp.stock (args) ...) — ARGS is a hash table: parameter name -> JSON-like value."
  `(setf (gethash (name-fold ,(string-downcase (string name))) *implementations*)
         (lambda (,args) (declare (ignorable ,args)) ,@body)))

(define-condition run-problem (error)
  ((code :initarg :code :reader problem-code) (message :initarg :message :reader problem-message)))

(defun problem (code fmt &rest args)
  (error 'run-problem :code code :message (apply #'format nil fmt args)))

(defun to-host (v)
  "Run-time value -> JSON-like value for an implementation."
  (cond ((rec-p v) (let ((h (make-hash-table :test #'equal))) (loop for (k . x) in (cdr v) do (setf (gethash k h) (to-host x))) h))
        ((lst-p v) (map 'vector #'to-host (cdr v)))
        ((eq v :none) :null)
        (t v)))

(defun from-host (x type where)
  "JSON-like value from an implementation -> run-time value of TYPE, or BAD-RESULT."
  (flet ((bad () (problem "bad-result" "~a returned ~a where ~a was declared" where (canonical-json x) (type-name type))))
    (let ((kind (if (consp type) (first type) type)))
      (case kind
        (:any (cond ((hash-table-p x) (rec (loop for k being the hash-keys of x using (hash-value y)
                                                 collect (cons (name-fold k) (from-host y :any where)))))
                    ((and (vectorp x) (not (stringp x))) (from-host-list x :any where))
                    ((member x '(:null nil)) :none)
                    ((floatp x) (rational x))
                    (t x)))
        (:enum (let ((v (from-host x (second type) where)))
                 (if (member v (third type) :test (lambda (a b) (if (and (stringp a) (stringp b))
                                                                    (string= (fold a) (fold b))
                                                                    (and (rationalp a) (rationalp b) (= a b)))))
                     v
                     (bad))))
        (:text (if (stringp x) x (bad)))
        (:number (cond ((rationalp x) x) ((floatp x) (rational x)) (t (bad))))
        (:bool (if (member x '(:true :false)) x (bad)))
        (:list (if (and (vectorp x) (not (stringp x))) (from-host-list x (second type) where) (bad)))
        (:record (if (hash-table-p x)
                     (rec (loop for (f . ft) in (rest type)
                                collect (cons f (let ((k (find f (loop for k being the hash-keys of x collect k)
                                                               :key #'name-fold :test #'string=)))
                                                  (if k (from-host (gethash k x) ft where) (bad))))))
                     (bad)))
        (t (bad))))))

(defun from-host-list (x item-type where)
  (when (> (length x) *max-list*)
    (problem "list-too-long" "~a returned ~d items; a plan loops over at most ~d" where (length x) *max-list*))
  (cons :list (map 'list (lambda (y) (from-host y item-type where)) x)))

;;; ------------------------------------------------------------------
;;; Journal and audit record
;;; ------------------------------------------------------------------

(defstruct journal (entries (make-hash-table :test #'equal)) path)

(defun journal-load (j)
  (when (and (journal-path j) (probe-file (journal-path j)))
    (with-open-file (s (journal-path j) :external-format :utf-8)
      (loop for line = (read-line s nil) while line
            when (plusp (length line))
              do (let ((e (json:json-oku line)))
                   (if (equal (gethash "status" e) "released")
                       (remhash (gethash "key" e) (journal-entries j))
                       (setf (gethash (gethash "key" e) (journal-entries j)) e))))))
  j)

(defun open-journal (path)
  "A journal kept in a file (one JSON object per line), loaded if it exists."
  (journal-load (make-journal :path path)))

(defun journal-get (j key) (and j (gethash key (journal-entries j))))

(defun journal-put (j key status result)
  (let ((line (canonical-json (obj "key" key "status" status "result" result))))
    (setf (gethash key (journal-entries j)) (json:json-oku line))
    (when (journal-path j)
      (with-open-file (s (journal-path j) :direction :output :if-exists :append :if-does-not-exist :create
                                          :external-format :utf-8)
        (write-line line s)))))

(defun journal-claim (j key)
  "SPEC 10.4: if KEY has no entry, record it as pending and return NIL (claimed); otherwise return the
entry that is there. One process: the check and the write cannot interleave. (The TypeScript
implementation also claims atomically between processes.)"
  (or (journal-get j key)
      (progn (journal-put j key "pending" :null) nil)))

(defun journal-release (j key)
  "The call did not happen: the step may run again."
  (remhash key (journal-entries j))
  (when (journal-path j)
    (with-open-file (s (journal-path j) :direction :output :if-exists :append :if-does-not-exist :create
                                        :external-format :utf-8)
      (write-line (canonical-json (obj "key" key "status" "released" "result" :null)) s))))

(defstruct audit path (seq 0) (prev (make-string 64 :initial-element #\0)) (lines '()))

(defun open-audit (path)
  "An audit record kept in PATH. If the file exists, the chain continues from its last line (its seq,
and the SHA-256 of that line as prev), so that restarting the host never starts a second chain."
  (let ((a (make-audit :path path)))
    (when (probe-file path)
      (with-open-file (s path :external-format :utf-8)
        (let ((last nil))
          (loop for line = (read-line s nil) while line
                when (plusp (length line)) do (setf last line))
          (when last
            (setf (audit-seq a) (gethash "seq" (json:json-oku last))
                  (audit-prev a) (sha256-hex last))))))
    a))

(defun iso-time ()
  (multiple-value-bind (s mi h d mo y) (decode-universal-time (get-universal-time) 0)
    (format nil "~4,'0d-~2,'0d-~2,'0dT~2,'0d:~2,'0d:~2,'0dZ" y mo d h mi s)))

(defun audit-append (a type data)
  (when a
    (let ((line (canonical-json (obj "seq" (incf (audit-seq a)) "type" type "time" (iso-time)
                                     "prev" (audit-prev a) "data" data))))
      (setf (audit-prev a) (sha256-hex line))
      (push line (audit-lines a))
      (when (audit-path a)
        (with-open-file (s (audit-path a) :direction :output :if-exists :append :if-does-not-exist :create
                                          :external-format :utf-8)
          (write-line line s))))))

(defun verify-audit (path)
  "T if every line's prev is the SHA-256 of the line before it; otherwise (values NIL line-number)."
  (with-open-file (s path :external-format :utf-8)
    (let ((prev (make-string 64 :initial-element #\0)))
      (loop for line = (read-line s nil) for n from 1 while line
            do (unless (string= (gethash "prev" (json:json-oku line)) prev) (return-from verify-audit (values nil n)))
               (setf prev (sha256-hex line))))
    t))

;;; ------------------------------------------------------------------
;;; Evaluator
;;; ------------------------------------------------------------------

(defstruct (plan-step (:conc-name step-)) index operation args key already-done status result
  requires        ; policy: ((role four-eyes rule-name) ...) approvals this step needs besides the person's own
  sources         ; ((param . (source-name ...)) ...): where each argument comes from (SPEC 5)
  journal-status) ; already-done: its key is in the journal; this says done, pending or unknown

(defvar *approvers* '() "Execution: the people who approved (ACTORs).")
(defvar *preview-actor* nil "Execution: who asked for the plan.")

(defun policy-args (argv)
  "Arguments as policy conditions see them: a value not known yet (pending) is :unknown."
  (mapcar (lambda (a) (cons (car a) (if (pending-p (cdr a)) :unknown (cdr a)))) argv))

(defun step-policy (op argv)
  "(values denials requires) for a call of OP with ARGV under *POLICY* and *ACTOR*."
  (let ((denials '()) (requires '()) (args (policy-args argv)))
    (dolist (r *policy*)
      (when (and (rule-concerns-p r op) (rule-args-match-p r args))
        (case (first (rule-decision r))
          (:deny (push (cons (rule-name r) (second (rule-decision r))) denials))
          (:approve (when (side-effect-p (op-effect op))
                      (pushnew (list (second (rule-decision r)) (third (rule-decision r)) (rule-name r))
                               requires :test #'equal))))))
    (values (reverse denials) (reverse requires))))

(defun denial-text (op denials)
  (format nil "~a is not allowed: ~{~a~^; ~}" (op-name op)
          (mapcar (lambda (d) (format nil "rule \"~a\"~@[ (~a)~]" (car d) (cdr d))) denials)))

(defun unmet-requirements (requires approvers actor)
  "The requirements no approver satisfies. Four eyes: the approver is not the person who asked."
  (remove-if (lambda (req)
               (destructuring-bind (role four-eyes rule) req
                 (declare (ignore rule))
                 (some (lambda (a) (and (member role (actor-roles a) :test #'string=)
                                        (not (and four-eyes actor (equal (actor-id a) (actor-id actor))))))
                       approvers)))
             requires))

(defun requirements-text (requires actor)
  (format nil "~{~a~^; ~}"
          (mapcar (lambda (r) (destructuring-bind (role four-eyes rule) r
                                (format nil "approval by ~a~:[~*~; (someone other than ~a)~] (rule \"~a\")"
                                        role (and four-eyes actor) (and actor (actor-id actor)) rule)))
                  requires)))

(defvar *mode*)          ; :preview or :execute
(defvar *steps*)         ; steps reached so far (reverse order)
(defvar *journal*)
(defvar *audit*)
(defvar *checked-calls* nil)   ; the checker's calls, with where each argument comes from
(defvar *previewed*)     ; execute: the preview's steps

(define-condition plan-stopped (error) ((reason :initarg :reason :reader stop-reason)))
(define-condition plan-halted (error) ((outcome :initarg :outcome :reader halt-outcome)
                                       (message :initarg :message :reader halt-message)))

(defun no-pending (v what)
  (when (pending-p v)
    (problem "depends-on-write" "~a uses ~a, which is only known after the plan runs" what (value-text v)))
  v)

(defun truthy (v) (eq (no-pending v "a condition") :true))

(defun num (v) (no-pending v "arithmetic") v)

(defun value-equal (a b)
  (cond ((and (stringp a) (stringp b)) (string= (fold a) (fold b)))
        ((and (rationalp a) (rationalp b)) (= a b))
        (t (string= (canonical-json a) (canonical-json b)))))

(defun bool (x) (if x :true :false))

(defun eval-body (body env)
  (let ((last :none)) (dolist (e body last) (setf last (eval-expr e env)))))

(defun eval-expr (node env)
  (ecase (node-kind node)
    (:number (node-value node))
    (:text (node-value node))
    (:name (cdr (assoc (name-fold (node-value node)) env :test #'string=)))
    (:list (eval-form node env))))

(defun eval-form (node env)
  (let* ((items (node-value node)) (k (name-fold (node-value (first items)))) (args (rest items)))
    (flet ((vals () (mapcar (lambda (a) (eval-expr a env)) args)))
      (cond
        ((string= k "let")
         (dolist (b (node-value (first args)))
           (let ((parts (node-value b)))
             (push (cons (name-fold (node-value (first parts))) (eval-expr (second parts) env)) env)))
         (eval-body (rest args) env))
        ((string= k "for-each")
         (let* ((parts (node-value (first args)))
                (l (no-pending (eval-expr (second parts) env) "for-each"))
                (var (name-fold (node-value (first parts)))))
           (dolist (item (cdr l) :none)
             (eval-body (rest args) (acons var item env)))))
        ((string= k "if")
         (if (truthy (eval-expr (first args) env))
             (eval-expr (second args) env)
             (if (third args) (eval-expr (third args) env) :none)))
        ((string= k "do") (eval-body args env))
        ((string= k "stop")
         (error 'plan-stopped :reason (format nil "~{~a~^ ~}" (mapcar #'value-text (vals)))))
        ((string= k "list") (cons :list (vals)))
        ((string= k "record")
         (rec (loop for (f v) on args by #'cddr collect (cons (name-fold (node-value f)) (eval-expr v env)))))
        ((string= k "get")
         (let ((r (eval-expr (first args) env)) (f (name-fold (node-value (second args)))))
           (cond ((pending-p r) (make-pending :step (pending-step r) :path (append (pending-path r) (list f))))
                 ((rec-p r) (let ((x (assoc f (cdr r) :test #'string=)))
                              (if x (cdr x) (problem "bad-result" "the record has no field ~a" f))))
                 (t (problem "bad-result" "get on ~a, which is not a record" (value-text r))))))
        ((string= k "+") (reduce #'+ (mapcar #'num (vals))))
        ((string= k "*") (reduce #'* (mapcar #'num (vals))))
        ((string= k "-") (let ((ns (mapcar #'num (vals)))) (if (rest ns) (reduce #'- ns) (- (first ns)))))
        ((string= k "/") (let ((ns (mapcar #'num (vals))))
                           (when (zerop (second ns)) (problem "division-by-zero" "division by zero on line ~d" (node-line node)))
                           (/ (first ns) (second ns))))
        ((member k '("=" "!=") :test #'string=)
         (let ((vs (mapcar (lambda (v) (no-pending v "a comparison")) (vals))))
           (bool (if (string= k "=") (value-equal (first vs) (second vs)) (not (value-equal (first vs) (second vs)))))))
        ((member k '("<" ">" "<=" ">=") :test #'string=)
         (let ((ns (mapcar #'num (vals))))
           (bool (funcall (cdr (assoc k '(("<" . <) (">" . >) ("<=" . <=) (">=" . >=)) :test #'string=))
                          (first ns) (second ns)))))
        ((string= k "and") (bool (every #'truthy (vals))))
        ((string= k "or") (bool (some #'truthy (vals))))
        ((string= k "not") (bool (not (truthy (first (vals))))))
        (t (eval-call node (gethash k *operations*) args env))))))

(defun step-key-text (op args)
  (let ((keys (mapcar #'name-fold (op-key op))))
    (canonical-json (vector (name-fold (op-name op))
                            (cons :object (loop for (k . v) in args
                                                when (or (null keys) (member (name-fold k) keys :test #'string=))
                                                  collect (cons k v)))))))

(defun args-match-p (previewed actual)
  "A pending value in the preview matches anything; everything else must be equal."
  (cond ((pending-p previewed) t)
        ((and (rec-p previewed) (rec-p actual))
         (and (= (length (cdr previewed)) (length (cdr actual)))
              (every (lambda (p a) (and (string= (car p) (car a)) (args-match-p (cdr p) (cdr a))))
                     (cdr previewed) (cdr actual))))
        ((and (lst-p previewed) (lst-p actual))
         (and (= (length previewed) (length actual)) (every #'args-match-p (cdr previewed) (cdr actual))))
        (t (string= (canonical-json previewed) (canonical-json actual)))))

(defun call-implementation (op args)
  (let ((impl (gethash (name-fold (op-name op)) *implementations*)))
    (unless impl (problem "no-implementation" "the host has no implementation of ~a" (op-name op)))
    (funcall impl (to-host (rec args)))))

(defun eval-call (node op args env)
  (let ((argv (loop for (p v) on args by #'cddr
                    collect (cons (pa-name (find (name-fold (node-value p)) (op-params op)
                                                 :key (lambda (x) (name-fold (pa-name x))) :test #'string=))
                                  (eval-expr v env)))))
    (setf argv (sort argv #'string< :key #'car))
    (if (not (side-effect-p (op-effect op)))
        ;; read
        (progn
          (dolist (a argv) (no-pending (cdr a) (format nil "~a (a read)" (op-name op))))
          (let ((denials (step-policy op argv)))
            (when denials
              (if (eq *mode* :preview)
                  (problem "policy-denied" "~a" (denial-text op denials))
                  (error 'plan-halted :outcome "denied" :message (denial-text op denials)))))
          (handler-case (from-host (call-implementation op argv) (op-returns op) (op-name op))
            (operation-failed (e) (problem "read-failed" "~a failed: ~a" (op-name op) (outcome-message e)))
            (operation-unknown (e) (problem "read-failed" "~a did not answer: ~a" (op-name op) (outcome-message e)))))
        ;; side effect
        (let* ((index (1+ (length *steps*)))
               (key (step-key-text op argv))
               (done (journal-get *journal* key))
               (st (make-plan-step :index index :operation op :args (rec argv) :key key :already-done (and done t) :journal-status (and done (gethash "status" done))
                                   :sources (let ((c (find-if (lambda (c) (and (= (call-line c) (node-line node))
                                                                               (eql (call-column c) (node-column node))))
                                                              *checked-calls*)))
                                              (and c (call-sources c))))))
          (push st *steps*)
          (when (eq *mode* :preview)
            (multiple-value-bind (denials requires) (step-policy op argv)
              (setf (step-requires st) requires)
              (when denials
                (problem "policy-denied" "step ~d: ~a" index (denial-text op denials)))))
          (ecase *mode*
            (:preview
             (when (find key (rest *steps*) :key #'step-key :test #'string=)
               (problem "duplicate-step" "step ~d (~a) is the same as an earlier step: same operation, same key ~a"
                        index (op-name op) key))
             (make-pending :step index))
            (:execute
             (let ((p (find index *previewed* :key #'step-index)))
               (unless (and p (string= (op-name (step-operation p)) (op-name op)) (args-match-p (step-args p) (step-args st)))
                 (setf (step-status st) "not_run")
                 (error 'plan-halted :outcome "changed"
                                     :message (if p
                                                  (format nil "step ~d: approved ~a ~a, now ~a ~a" index
                                                          (op-name (step-operation p)) (canonical-json (step-args p))
                                                          (op-name op) (canonical-json (step-args st)))
                                                  (format nil "step ~d (~a) was not in the approved preview" index (op-name op)))))
               ;; What was approved is unchanged; the policy is applied again with the actual values
               ;; (a pending value from the preview is known now).
               (multiple-value-bind (denials requires) (step-policy op argv)
                 (setf (step-requires st) requires)
                 (when denials
                   (setf (step-status st) "not_run")
                   (error 'plan-halted :outcome "denied" :message (format nil "step ~d: ~a" index (denial-text op denials))))
                 (let ((unmet (and (not (and done (equal (gethash "status" done) "done")))
                                   (unmet-requirements requires *approvers* *preview-actor*))))
                   (when unmet
                     (setf (step-status st) "not_run")
                     (error 'plan-halted :outcome "not-approved"
                                         :message (format nil "step ~d (~a) needs ~a" index (op-name op)
                                                          (requirements-text unmet *preview-actor*))))))
               (flet ((unresolved (entry)
                        (setf (step-status st) "unresolved")
                        (error 'plan-halted :outcome "unresolved"
                                            :message (format nil "step ~d (~a) is in the journal as ~a: ~a; it may have happened. A person should check and resolve it (done or released); it was not run again"
                                                             index (op-name op) (gethash "status" entry)
                                                             (if (equal (gethash "status" entry) "pending")
                                                                 "another execution is running it, or one stopped during the call"
                                                                 "an earlier call's outcome is unknown"))))
                      (record (status &rest more)
                        (audit-append *audit* "call" (apply #'obj "step" index "operation" (op-name op) "args" (step-args st)
                                                            "status" status more))))
                 (when (and done (equal (gethash "status" done) "done"))
                   (setf (step-status st) "already_done")
                   (return-from eval-call (from-host-or-any (gethash "result" done) op)))
                 (when done (unresolved done))
                 ;; Claim, then call (SPEC 10.4): never twice, not even across a crash.
                 (let ((other (journal-claim *journal* key)))
                   (when (and other (equal (gethash "status" other) "done"))
                     (setf (step-status st) "already_done")
                     (return-from eval-call (from-host-or-any (gethash "result" other) op)))
                   (when other (unresolved other)))
                 (let ((raw (handler-case (call-implementation op argv)
                              (run-problem (e)   ; no implementation: nothing was called
                                (journal-release *journal* key)
                                (error e))
                              (operation-failed (e)
                                (setf (step-status st) "failed")
                                (journal-release *journal* key)
                                (record "failed" "message" (outcome-message e))
                                (error 'plan-halted :outcome "failed" :message (format nil "step ~d (~a) failed: ~a" index (op-name op) (outcome-message e))))
                              (error (e)
                                (setf (step-status st) "unknown")
                                (journal-put *journal* key "unknown" :null)
                                (record "unknown" "message" (if (typep e 'operation-unknown) (outcome-message e) (princ-to-string e)))
                                (error 'plan-halted :outcome "unknown"
                                                    :message (format nil "step ~d (~a): the outcome is unknown (~a); it will not be run again by itself"
                                                                     index (op-name op) (if (typep e 'operation-unknown) (outcome-message e) e))))))
                       (v nil))
                   (handler-case (setf v (from-host raw (op-returns op) (op-name op)))
                     (run-problem (e)
                       ;; It ran, but answered with something that does not fit its declaration.
                       (setf (step-status st) "unknown")
                       (journal-put *journal* key "unknown" :null)
                       (record "unknown" "message" (problem-message e))
                       (error 'plan-halted :outcome "unknown"
                                           :message (format nil "step ~d (~a) ran but ~a; it will not be run again by itself"
                                                            index (op-name op) (problem-message e)))))
                   (setf (step-status st) "done" (step-result st) v)
                   (journal-put *journal* key "done" v)
                   (record "done" "result" v)
                   v)))))))))

(defun from-host-or-any (x op)
  (handler-case (from-host x (op-returns op) (op-name op))
    (run-problem () (from-host x :any (op-name op)))))

;;; ------------------------------------------------------------------
;;; Preview and execute
;;; ------------------------------------------------------------------

(defstruct (preview (:conc-name preview-)) text message check status steps problems stop-reason hash used
  actor policy)
(defstruct (execution (:conc-name execution-)) outcome steps message stop-reason)

(defun plan-body (text) (cddr (node-value (read-plan text))))

(defun steps-json (steps)
  (map 'vector (lambda (s) (obj "index" (step-index s) "operation" (op-name (step-operation s))
                                "effect" (op-effect (step-operation s)) "args" (step-args s) "key" (step-key s)
                                "already_done" (bool (step-already-done s)) "journal_status" (or (step-journal-status s) :null)
                                "requires" (map 'vector (lambda (r) (obj "role" (first r) "four_eyes" (bool (second r))
                                                                         "rule" (third r)))
                                                (step-requires s))
                                "sources" (apply #'obj (loop for (k . srcs) in (step-sources s) append (list k (coerce srcs 'vector))))))
       steps))

(defun journal-note (s)
  "A step already in the journal, for a person: done, or unresolved (it may or may not have happened)."
  (cond ((not (step-already-done s)) "")
        ((equal (step-journal-status s) "done") " (already done before; will not run again)")
        (t " (an earlier run may or may not have happened; it will not run until a person resolves it)")))

(defun source-text (sources)
  "Where a value comes from, for a person: from the message, from erp, written by the assistant."
  (flet ((word (s) (cond ((string= s "message") "the message") ((string= s "tool") "a tool")
                         ((and (> (length s) 5) (string= "tool:" s :end2 5)) (subseq s 5))
                         ((string= s "schema") "a declared value") (t s))))
    (let ((from (mapcar #'word (remove "model" sources :test #'string=))))
      (format nil "~{~a~^, ~}"
              (append (and from (list (format nil "from ~{~a~^ and ~}" from)))
                      (and (member "model" sources :test #'string=) (list "written by the assistant")))))))

(defun arg-with-source (s k v)
  (let ((src (cdr (assoc k (step-sources s) :test #'string=))))
    (format nil "~a=~a~@[ (~a)~]" k (visible (value-text v)) (and src (source-text src)))))

(defun preview (text &key message journal audit (policy *policy*) (actor *actor*) (profile *profile*))
  "Dry run (SPEC 10.3): reads run, side effects become steps, POLICY is applied for ACTOR (SPEC 12);
PROFILE is the language profile for the message (SPEC 5.4). Returns a PREVIEW."
  (let ((check (check-plan text :message message :policy policy :actor actor :profile profile))
        (*policy* policy) (*actor* actor)
        (*mode* :preview) (*steps* '()) (*journal* journal) (*audit* audit) (*checked-calls* nil)
        (problems '()) (status nil) (reason nil))
    (setf *checked-calls* (result-calls check))
    (if (not (result-valid check))
        (setf status "invalid")
        (handler-case (progn (eval-body (plan-body text) '()) (setf status (if *steps* "ready" "nothing")))
          (plan-stopped (e) (setf status (if *steps* "stopped" "nothing") reason (stop-reason e)))
          (run-problem (e)
            (setf status (if (string= (problem-code e) "policy-denied") "denied" "error"))
            (push (obj "code" (problem-code e) "message" (problem-message e)) problems))))
    (let* ((steps (reverse *steps*))
           (p (make-preview :text text :message message :check check :status status :steps steps
                            :problems (reverse problems) :stop-reason reason :actor actor :policy policy)))
      (when (member status '("ready" "stopped") :test #'string=)
        (setf (preview-hash p)
              (sha256-hex (canonical-json (obj "plan" text "message" (or message :null)
                                               "steps" (map 'vector (lambda (s) (obj "operation" (op-name (step-operation s))
                                                                                     "args" (step-args s) "key" (step-key s)))
                                                            steps))))))
      (audit-append audit "preview" (obj "plan" text "message" (or message :null) "valid" (bool (result-valid check))
                                         "actor" (if actor (obj "id" (actor-id actor) "roles" (coerce (actor-roles actor) 'vector)) :null)
                                         "status" status "steps" (steps-json steps) "hash" (or (preview-hash p) :null)
                                         "stop_reason" (or reason :null)))
      p)))

(defun execute (p approval &key journal audit (approved-by "unknown") approvers signatures)
  "Runs the approved preview P (SPEC 10.4). APPROVAL must be P's hash. APPROVERS (ACTORs) are the
people who approved it; by default the person who asked. Returns an EXECUTION."
  (let* ((approvers (or approvers (and (preview-actor p) (list (preview-actor p)))))
         (unmet (unmet-requirements (remove-duplicates
                                     (loop for st in (preview-steps p) unless (step-already-done st) append (step-requires st))
                                     :test #'equal)
                                    approvers (preview-actor p))))
    (when (and unmet (preview-hash p) (equal approval (preview-hash p)) (not (preview-used p)))
      (audit-append audit "outcome" (obj "outcome" "not-approved" "message" (requirements-text unmet (preview-actor p))))
      (return-from execute
        (make-execution :outcome "not-approved" :steps '()
                        :message (format nil "this plan needs ~a; nothing ran" (requirements-text unmet (preview-actor p))))))
    (setf *approvers* approvers))
  (when (or (not (preview-hash p)) (not (equal approval (preview-hash p))) (preview-used p))
    (audit-append audit "outcome" (obj "outcome" "not-approved"))
    (return-from execute (make-execution :outcome "not-approved" :steps '()
                                         :message (if (preview-used p)
                                                      "this preview was already executed; an approval is for one execution"
                                                      "the approval does not match this preview; nothing ran"))))
  (setf (preview-used p) t)
  (audit-append audit "approval" (apply #'obj "hash" approval "by" approved-by
                                        "approvers" (map 'vector (lambda (a) (obj "id" (actor-id a) "roles" (coerce (actor-roles a) 'vector)))
                                                         *approvers*)
                                        ;; signed approvals by other people (SPEC 11.6)
                                        (and signatures (list "signatures" (coerce signatures 'vector)))))
  (let ((*mode* :execute) (*steps* '()) (*journal* (or journal (make-journal))) (*audit* audit) (*previewed* (preview-steps p))
        (*policy* (preview-policy p)) (*actor* (preview-actor p)) (*preview-actor* (preview-actor p))
        (*checked-calls* (result-calls (preview-check p)))
        (outcome nil) (message nil) (reason nil))
    (handler-case (progn (eval-body (plan-body (preview-text p)) '())
                         (setf outcome (if (< (length *steps*) (length *previewed*)) "changed" "done"))
                         (when (string= outcome "changed")
                           (setf message (format nil "the plan reached ~d of the ~d approved steps" (length *steps*) (length *previewed*)))))
      (plan-stopped (e) (setf outcome "stopped" reason (stop-reason e)))
      (plan-halted (e) (setf outcome (halt-outcome e) message (halt-message e)))
      (run-problem (e) (setf outcome "changed" message (format nil "~a: ~a" (problem-code e) (problem-message e)))))
    (let* ((reached (reverse *steps*))
           (all (append reached
                        (mapcar (lambda (s) (make-plan-step :index (step-index s) :operation (step-operation s)
                                                       :args (step-args s) :key (step-key s) :status "not_run"))
                                (remove-if (lambda (s) (find (step-index s) reached :key #'step-index)) *previewed*)))))
      (dolist (s all) (unless (step-status s) (setf (step-status s) "not_run")))
      (audit-append audit "outcome" (obj "outcome" outcome "message" (or message :null) "stop_reason" (or reason :null)
                                         "steps" (map 'vector (lambda (s) (obj "index" (step-index s) "status" (step-status s))) all)))
      (make-execution :outcome outcome :steps all :message message :stop-reason reason))))

(defun preview-json (p)
  (obj "status" (preview-status p) "hash" (or (preview-hash p) :null) "stop_reason" (or (preview-stop-reason p) :null)
       "problems" (coerce (preview-problems p) 'vector) "steps" (steps-json (preview-steps p))))

(defun execution-json (e)
  (obj "outcome" (execution-outcome e) "message" (or (execution-message e) :null)
       "stop_reason" (or (execution-stop-reason e) :null)
       "steps" (map 'vector (lambda (s) (obj "index" (step-index s) "operation" (op-name (step-operation s))
                                             "status" (step-status s)))
                    (execution-steps e))))

(defun visible (s)
  "Text as a person approving it must see it: control characters written out (a newline in a value
must not look like a new step), invisible or direction-changing characters named (U+202E can make
an IBAN read differently). Everything else stays as it is."
  (with-output-to-string (o)
    (loop for c across s
          for code = (char-code c)
          do (cond ((char= c #\\) (write-string "\\\\" o))
                   ((char= c #\Newline) (write-string "\\n" o))
                   ((= code 13) (write-string "\\r" o))
                   ((= code 9) (write-string "\\t" o))
                   ((or (member (sb-unicode:general-category c) '(:cc :cf :zl :zp))
                        (member code '(#x34f #x115f #x1160 #x17b4 #x17b5 #x3164 #xffa0))
                        (<= #xfe00 code #xfe0f))
                    (format o "⟨U+~4,'0X⟩" code))
                   (t (write-char c o))))))

(defun preview-summary (p)
  "What the person approves. Everything the model or a tool wrote goes through VISIBLE."
  (with-output-to-string (o)
    (format o "Plan: ~a~%" (visible (or (result-title (preview-check p)) "")))
    (cond ((string= (preview-status p) "invalid")
           (format o "The plan did not run:~%")
           (loop for e in (result-errors (preview-check p)) for i from 1
                 do (format o "~d. line ~d, column ~d [~a]: ~a~%" i (soz-error-line e) (soz-error-column e)
                            (soz-error-code e) (visible (soz-error-message e)))))
          (t
           (when (preview-steps p)
             (format o "If you approve, these will happen:~%")
             (dolist (s (preview-steps p))
               (format o "  ~d. ~a~{ ~a~}~a~%"
                       (step-index s) (op-name (step-operation s))
                       (loop for (k . v) in (cdr (step-args s)) collect (arg-with-source s k v))
                       (journal-note s))
               (when (and (step-requires s) (not (step-already-done s)))
                 (format o "     needs ~a~%" (requirements-text (step-requires s) (preview-actor p))))))
           (when (preview-stop-reason p) (format o "The plan stops: ~a~%" (visible (preview-stop-reason p))))
           (dolist (pr (preview-problems p)) (format o "Cannot run: ~a~%" (visible (cdr (assoc "message" (cdr pr) :test #'string=)))))
           (when (string= (preview-status p) "nothing") (format o "Nothing to do.~%"))
           (when (preview-hash p) (format o "Preview: ~a~%" (subseq (preview-hash p) 0 12)))))))

