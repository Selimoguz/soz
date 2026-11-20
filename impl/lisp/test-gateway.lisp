;;;; test-gateway.lisp — End-to-end test of the MCP gateway: this script is the MCP client (the
;;;; "agent" and the "user"), the gateway runs as a real process, the fake ERP behind it as another.
;;;; sbcl --script impl/lisp/test-gateway.lisp

(setf sb-impl::*default-external-format* :utf-8)
(let ((*standard-output* *error-output*))
  (load (merge-pathnames "json.lisp" *load-truename*)))

(defvar *here* (make-pathname :name nil :type nil :defaults *load-truename*))
(defvar *failed* 0)
(defmacro check (description form)
  `(if (ignore-errors ,form)
       (format t "  ok    ~a~%" ,description)
       (progn (incf *failed*) (format t "  FAIL  ~a~%" ,description))))

(defun temp-dir ()
  (pathname (concatenate 'string (string-right-trim "/\\" (or (sb-ext:posix-getenv "TEMP") (sb-ext:posix-getenv "TMPDIR") "/tmp")) "/")))

(defvar *dir* (merge-pathnames (format nil "soz-gateway-test-~d/" (random 1000000 (make-random-state t))) (temp-dir)))

(defun substitute-string (s old new)
  (let ((i (search old s))) (if i (concatenate 'string (subseq s 0 i) new (subseq s (+ i (length old)))) s)))

(defun write-config (name approval &optional extra)
  (let ((path (merge-pathnames name *dir*)))
    (with-open-file (s path :direction :output :if-exists :supersede :external-format :utf-8)
      (format s "{\"servers\": {\"erp\": {\"command\": \"sbcl\", \"args\": [\"--script\", ~s]}},
 \"operations\": {\"erp.add_order_line\": {\"key\": [\"customer\", \"product\", \"quantity\"], \"model_allowed\": [\"note\"]}},
 ~@[~a,~] \"approval\": ~s, \"journal\": \"journal.jsonl\", \"audit\": \"audit.jsonl\"}"
              (substitute #\/ #\\ (namestring (merge-pathnames "../../examples/gateway/fake-erp.lisp" *here*))) extra approval))
    path))

;;; A minimal MCP client
(defstruct client process in out (id 0))

(defun connect (config &key (elicitation t) code-file)
  (let* ((p (sb-ext:run-program "sbcl" (list "--script" (namestring (merge-pathnames "soz-mcp.lisp" *here*)) (namestring config))
                                :search t :wait nil :input :stream :output :stream :error nil :external-format :utf-8
                                :environment (append (when code-file (list (format nil "SOZ_TEST_CODE_FILE=~a" (namestring code-file))))
                                                     (sb-ext:posix-environ))))
         (c (make-client :process p :in (sb-ext:process-input p) :out (sb-ext:process-output p))))
    (request c "initialize" (json:json-nesne "protocolVersion" "2025-06-18"
                                             "capabilities" (if elicitation (json:json-nesne "elicitation" (json:json-nesne)) (json:json-nesne))
                                             "clientInfo" (json:json-nesne "name" "test" "version" "1")))
    (notify c "notifications/initialized")
    c))

(defun put (c m) (write-line (json:json-yaz m) (client-in c)) (finish-output (client-in c)))
(defun notify (c method) (put c (json:json-nesne "jsonrpc" "2.0" "method" method)))
(defun next (c) (json:json-oku (read-line (client-out c))))

(defun request (c method params &key on-elicit)
  "Sends a request; answers elicitation requests with ON-ELICIT (message -> :accept-yes, :accept-no, :decline)."
  (let ((id (incf (client-id c))))
    (put c (json:json-nesne "jsonrpc" "2.0" "id" id "method" method "params" params))
    (loop (let ((m (next c)))
            (cond ((equal (gethash "method" m) "elicitation/create")
                   (let ((answer (if on-elicit (funcall on-elicit (json:json-al m "params" "message")) :decline)))
                     (put c (json:json-nesne "jsonrpc" "2.0" "id" (gethash "id" m)
                                             "result" (if (eq answer :decline)
                                                          (json:json-nesne "action" "decline")
                                                          (json:json-nesne "action" "accept"
                                                                           "content" (json:json-nesne "approve" (if (eq answer :accept-yes) :true :false))))))))
                  ((equal (gethash "id" m) id) (return (gethash "result" m))))))))

(defun call (c tool args &key on-elicit)
  (request c "tools/call" (json:json-nesne "name" tool "arguments" args) :on-elicit on-elicit))

(defun text-of (r) (json:json-al r "content" 0 "text"))
(defun error-p (r) (eq (gethash "isError" r) :true))
(defun preview-id (r)
  (let* ((text (text-of r)) (i (search "preview_id: " text)))
    (and i (subseq text (+ i 12) (+ i 12 64)))))

(defun close-client (c)
  (ignore-errors (close (client-in c)))
  (ignore-errors (sb-ext:process-wait (client-process c))))

(defparameter *message* "Please send Yilmaz Market 20 crates of tomatoes and 5 crates of peppers tomorrow.")
(defparameter *good* "(plan \"Order for Yilmaz Market\"
  (let ((c (erp.find_customer name \"Yilmaz Market\")))
    (if (> (get c balance) (get c limit))
        (stop \"over the limit\")
        (for-each (line (list (record product \"tomatoes\" quantity 20) (record product \"peppers\" quantity 5)))
          (erp.add_order_line customer (get c code) product (get line product) quantity (get line quantity))))))")

(ensure-directories-exist *dir*)
(format t "~%Gateway with elicitation~%")
(let* ((c (connect (write-config "gateway.json" "elicitation")))
       (tools (map 'list (lambda (x) (gethash "name" x)) (json:json-al (request c "tools/list" (json:json-nesne)) "tools")))
       (elicited nil))
  (check "offers soz_guide, soz_preview, soz_execute"
         (every (lambda (n) (member n tools :test #'string=)) '("soz_guide" "soz_preview" "soz_execute")))
  (check "passes read tools through" (and (member "erp_find_customer" tools :test #'string=)
                                          (member "erp_list_orders" tools :test #'string=)))
  (check "does not offer the write tool directly" (not (member "erp_add_order_line" tools :test #'string=)))
  (check "the guide lists the ERP's operations with their effects"
         (let ((g (text-of (call c "soz_guide" (json:json-nesne)))))
           (and (search "(erp.add_order_line" g) (search "effect: write" g) (search "effect: read" g))))
  (check "a pass-through read works" (search "C-1042" (text-of (call c "erp_find_customer" (json:json-nesne "name" "Yilmaz")))))

  (let ((r (call c "soz_preview" (json:json-nesne "plan" (substitute-string *good* "quantity 20" "quantity 25") "message" *message*))))
    (check "a plan with an invented quantity is refused with the reason" (and (error-p r) (search "invented-value" (text-of r)))))

  (let* ((r (call c "soz_preview" (json:json-nesne "plan" *good* "message" *message*)))
         (id (preview-id r)))
    (check "the good plan is previewed with its steps and a preview_id"
           (and (not (error-p r)) id (search "product=tomatoes quantity=20" (text-of r))))
    (check "the preview changed nothing"
           (string= "[]" (text-of (call c "erp_list_orders" (json:json-nesne)))))
    (let ((r2 (call c "soz_execute" (json:json-nesne "preview_id" id)
                    :on-elicit (lambda (msg) (setf elicited msg) :decline))))
      (check "execute asks the user, and their decline runs nothing"
             (and elicited (search "Approve these steps?" elicited) (search "Nothing ran" (text-of r2))
                  (string= "[]" (text-of (call c "erp_list_orders" (json:json-nesne)))))))
    (check "the approval question shows the message the plan is based on" (search *message* elicited))
    (let ((r3 (call c "soz_execute" (json:json-nesne "preview_id" id) :on-elicit (lambda (m) (declare (ignore m)) :accept-no))))
      (check "accepting the dialog without ticking approve runs nothing" (search "Nothing ran" (text-of r3))))
    (let ((r4 (call c "soz_execute" (json:json-nesne "preview_id" (subseq id 0 16))
                    :on-elicit (lambda (m) (declare (ignore m)) :accept-yes))))
      (check "approved: done, and the ERP has the two lines"
             (and (search "Outcome: done" (text-of r4))
                  (= 2 (length (json:json-oku (text-of (call c "erp_list_orders" (json:json-nesne)))))))))
    (let ((r5 (call c "soz_execute" (json:json-nesne "preview_id" id) :on-elicit (lambda (m) (declare (ignore m)) :accept-yes))))
      (check "the same preview cannot be executed twice" (and (error-p r5) (search "already executed" (text-of r5))))))

  (let* ((r (call c "soz_preview" (json:json-nesne "plan" *good* "message" *message*)))
         (r2 (call c "soz_execute" (json:json-nesne "preview_id" (preview-id r)) :on-elicit (lambda (m) (declare (ignore m)) :accept-yes))))
    (check "the same plan again: both steps already done" (search "already done" (text-of r)))
    (check "executing it orders nothing twice"
           (and (search "1 already_done, 2 already_done" (text-of r2))
                (= 2 (length (json:json-oku (text-of (call c "erp_list_orders" (json:json-nesne)))))))))
  (check "an unknown preview_id is refused" (error-p (call c "soz_execute" (json:json-nesne "preview_id" "0123456789abcdef"))))
  (close-client c))

(load (merge-pathnames "soz.lisp" *here*))
(load (merge-pathnames "run.lisp" *here*))
(check "the audit record's hash chain is intact" (soz:verify-audit (merge-pathnames "audit.jsonl" *dir*)))

(format t "~%Client without elicitation~%")
(let ((c (connect (write-config "gateway2.json" "elicitation") :elicitation nil)))
  (let ((id (preview-id (call c "soz_preview" (json:json-nesne "plan" *good*
                                                              "message" "Yilmaz Market: 20 tomatoes, 5 peppers")))))
    (check "with approval=elicitation, a client that cannot ask the user runs nothing"
           (let ((r (call c "soz_execute" (json:json-nesne "preview_id" id))))
             (and (error-p r) (search "cannot ask the user" (text-of r))))))
  (close-client c))

(format t "~%Approval code (approval=auto, client without elicitation)~%")
(defun read-code (file)
  (with-open-file (s file :external-format :utf-8)
    (let* ((line (read-line s)) (i (search "Approval code: " line)))
      (and i (subseq line (+ i 15) (+ i 22))))))
(defun orders (c) (length (json:json-oku (text-of (call c "erp_list_orders" (json:json-nesne))))))

(let* ((code-file (merge-pathnames "code.txt" *dir*))
       (c (connect (write-config "gateway3.json" "auto") :elicitation nil :code-file code-file))
       (msg "Yilmaz Market: 7 tomatoes and 3 peppers")
       (plan (substitute-string (substitute-string *good* "quantity 20" "quantity 7") "quantity 5" "quantity 3"))
       (id (preview-id (call c "soz_preview" (json:json-nesne "plan" plan "message" msg)))))
  (check "the preview tells the model the user will be shown a code"
         (search "approval code outside this chat" (text-of (call c "soz_preview" (json:json-nesne "plan" plan "message" msg)))))
  (check "a code without one being issued is refused"
         (error-p (call c "soz_execute" (json:json-nesne "preview_id" id "approval_code" "AAA-AAA"))))
  (let ((r (call c "soz_execute" (json:json-nesne "preview_id" id))))
    (check "execute without a code shows the user a code and runs nothing"
           (and (search "approval code is now shown" (text-of r)) (= 0 (orders c)))))
  (let ((code (read-code code-file)))
    (check "the user's window has the code, the steps and the message"
           (and code (with-open-file (s code-file :external-format :utf-8)
                       (let ((text (make-string (file-length s))))
                         (setf text (subseq text 0 (read-sequence text s)))
                         (and (search "quantity=7" text) (search msg text))))))
    (check "the model never saw the code" (not (search code (text-of (call c "soz_preview" (json:json-nesne "plan" plan "message" msg))))))
    (check "a wrong code runs nothing"
           (let ((r (call c "soz_execute" (json:json-nesne "preview_id" id "approval_code" "XXX-XXX"))))
             (and (error-p r) (search "Wrong approval code" (text-of r)) (= 0 (orders c)))))
    (check "the user's code, typed loosely (lower case, no dash), runs the plan"
           (let ((r (call c "soz_execute" (json:json-nesne "preview_id" id "approval_code" (string-downcase (remove #\- code))))))
             (and (search "Outcome: done" (text-of r)) (= 2 (orders c)))))
    (check "the same code cannot be used twice"
           (error-p (call c "soz_execute" (json:json-nesne "preview_id" id "approval_code" code)))))
  (let* ((plan2 (substitute-string plan "quantity 7" "quantity 3"))
         (id2 (preview-id (call c "soz_preview" (json:json-nesne "plan" plan2 "message" msg)))))
    (call c "soz_execute" (json:json-nesne "preview_id" id2))
    (let ((code (read-code code-file)))
      (dotimes (i 3) (call c "soz_execute" (json:json-nesne "preview_id" id2 "approval_code" "WRONG1")))
      (check "three wrong codes lock the preview, even for the right code"
             (let ((r (call c "soz_execute" (json:json-nesne "preview_id" id2 "approval_code" code))))
               (and (error-p r) (search "locked" (text-of r)) (= 2 (orders c)))))))
  (close-client c))

(format t "~%Policy (actor ali, role sales)~%")
(let* ((code-file (merge-pathnames "code-policy.txt" *dir*))
       (c (connect (write-config "gateway4.json" "auto"
                                 "\"actor\": {\"id\": \"ali\", \"roles\": [\"sales\"]},
 \"policy\": {\"rules\": [
   {\"name\": \"orders over 10 need a manager\", \"when\": {\"operation\": \"erp.add_order_line\", \"args\": {\"quantity\": {\">\": 10}}}, \"then\": {\"approve_by\": \"manager\"}},
   {\"name\": \"no order line of 100 or more\", \"when\": {\"operation\": \"erp.add_order_line\", \"args\": {\"quantity\": {\">=\": 100}}}, \"then\": {\"deny\": \"too large\"}}]}")
                   :elicitation nil :code-file code-file))
       (msg "Yilmaz Market: 30 tomatoes, 8 peppers, or 200 tomatoes")
       (line (lambda (product qty)
               (format nil "(plan \"x\" (let ((c (erp.find_customer name \"Yilmaz Market\"))) (erp.add_order_line customer (get c code) product ~s quantity ~d)))" product qty))))
  (when (probe-file code-file) (delete-file code-file))
  (check "the guide lists the policy in force" (search "orders over 10 need a manager" (text-of (call c "soz_guide" (json:json-nesne)))))
  (let* ((r (call c "soz_preview" (json:json-nesne "plan" (funcall line "tomatoes" 30) "message" msg)))
         (id (preview-id r)))
    (check "the preview shows the approval a step needs" (search "needs approval by manager" (text-of r)))
    (let ((r2 (call c "soz_execute" (json:json-nesne "preview_id" id))))
      (check "the gateway cannot collect a manager's approval: it says so and nothing runs"
             (and (error-p r2) (search "needs approval by manager" (text-of r2)) (= 0 (orders c))))
      (check "no approval code was shown to the user for it" (not (probe-file code-file)))))
  (let ((r (call c "soz_preview" (json:json-nesne "plan" (funcall line "tomatoes" 200) "message" msg))))
    (check "a denied value: the preview says the policy does not allow it"
           (and (error-p r) (search "policy does not allow" (text-of r)) (search "too large" (text-of r)))))
  (let* ((id (preview-id (call c "soz_preview" (json:json-nesne "plan" (funcall line "peppers" 8) "message" msg))))
         (r (call c "soz_execute" (json:json-nesne "preview_id" id))))
    (check "a step the policy asks nothing more for goes through the user's own approval"
           (and (search "approval code is now shown" (text-of r))
                (search "Outcome: done" (text-of (call c "soz_execute" (json:json-nesne "preview_id" id "approval_code" (read-code code-file)))))
                (= 1 (orders c)))))
  (close-client c))

;;; Another person's approval: tokens signed by Node (impl/ts), verified here; the request this
;;; gateway writes is read by the TypeScript soz-approve. Skipped where Node is not installed.
(defun node (&rest args)
  "Runs a TypeScript file of impl/ts with Node: (values output exit-code), or NIL without Node."
  (handler-case
      (let* ((out (make-string-output-stream))
             (p (sb-ext:run-program "node" (list* "--experimental-strip-types" "--disable-warning=ExperimentalWarning"
                                                  (namestring (merge-pathnames (first args) (merge-pathnames "../ts/" *here*)))
                                                  (rest args))
                                    :search t :output out :error out :external-format :utf-8)))
        (values (string-trim '(#\Newline #\Return #\Space) (get-output-stream-string out)) (sb-ext:process-exit-code p)))
    (error () nil)))

(format t "~%Another person's approval (four eyes, signed)~%")
(let ((keys (node "test/approval-helper.ts" "keys" (namestring *dir*) "ayse" "ali" "veli")))
  (if (null keys)
      (format t "  skipped: Node is not installed~%")
      (let* ((pub (json:json-oku keys))
             (code-file (merge-pathnames "code-four-eyes.txt" *dir*))
             (c (connect (write-config "gateway5.json" "auto"
                                       (format nil "\"actor\": {\"id\": \"ali\", \"roles\": [\"sales\", \"finance\"]},
 \"approvers\": [{\"id\": \"ayse\", \"roles\": [\"finance\"], \"public_key\": ~s}, {\"id\": \"ali\", \"roles\": [\"finance\"], \"public_key\": ~s},
                 {\"id\": \"veli\", \"roles\": [\"sales\"], \"public_key\": ~s}],
 \"approval_requests\": \"requests\",
 \"policy\": {\"rules\": [{\"name\": \"orders over 10: finance, four eyes\", \"when\": {\"operation\": \"erp.add_order_line\", \"args\": {\"quantity\": {\">\": 10}}},
                          \"then\": {\"approve_by\": \"finance\", \"four_eyes\": true}}]}"
                                               (gethash "ayse" pub) (gethash "ali" pub) (gethash "veli" pub)))
                         :elicitation nil :code-file code-file))
             (before (orders c))
             (id (preview-id (call c "soz_preview" (json:json-nesne "plan" "(plan \"x\" (let ((c (erp.find_customer name \"Yilmaz Market\"))) (erp.add_order_line customer (get c code) product \"tomatoes\" quantity 30)))"
                                                                  "message" "Yilmaz Market: 30 tomatoes"))))
             (asked (call c "soz_execute" (json:json-nesne "preview_id" id)))
             (path (let* ((s (text-of asked)) (i (search "written to:" s)))
                     (and i (string-trim '(#\Space #\Newline #\Return) (subseq s (+ i 11) (position #\Newline s :start (+ i 13)))))))
             (dir (namestring *dir*))
             (sign (lambda (who &key (hash id) expires key) (node "test/approval-helper.ts" "sign" dir who hash
                                                                 (if expires (princ-to-string expires) "")
                                                                 (or key who)))))
        (when (probe-file code-file) (delete-file code-file))
        (check "the gateway writes an approval request and names who can approve (not ali himself)"
               (and (error-p asked) path (probe-file path)
                    (search "approval by finance (someone other than ali): ayse" (text-of asked))))
        (multiple-value-bind (out code) (node "src/approve-cli.ts" "show" path)
          (check "the TypeScript soz-approve reads the Lisp gateway's request: the same hash"
                 (and (eql code 0) (search "erp.add_order_line" out) (search "quantity: 30" out))))
        (let ((ayse (funcall sign "ayse")))
          (dolist (try (list (list "a forged signature" (concatenate 'string (subseq ayse 0 (- (length ayse) 3))
                                                                     (if (search "AAA" ayse :start2 (- (length ayse) 3)) "BBB" "AAA"))
                                   "not ayse's approval")
                             (list "ayse's approval of another preview" (funcall sign "ayse" :hash (make-string 64 :initial-element #\0)) "not ayse's approval")
                             (list "an expired approval" (funcall sign "ayse" :expires 1000) "expired")
                             (list "a key that is not ayse's, under her name" (funcall sign "ayse" :key "veli") "not ayse's approval")
                             (list "someone the gateway does not know" (funcall sign "mallory" :key "veli") "not an approver")
                             (list "ali's own token: he approves in his own window" (funcall sign "ali") "ali is the user")
                             (list "veli's token: he is not finance" (funcall sign "veli") "no approval veli can give")))
            (destructuring-bind (what token why) try
              (let ((r (call c "soz_execute" (json:json-nesne "preview_id" id "approvals" (vector token)))))
                (check (format nil "~a is not accepted, nothing runs" what)
                       (and (error-p r) (search why (text-of r)) (not (probe-file code-file)) (= before (orders c)))))))
          (let ((shown (call c "soz_execute" (json:json-nesne "preview_id" id "approvals" (vector ayse)))))
            (check "with ayse's approval, ali is shown his own code, which says ayse approved"
                   (and (search "approval code is now shown" (text-of shown))
                        (with-open-file (s code-file :external-format :utf-8)
                          (search "Also approved by: ayse (finance)" (let ((x (make-string (file-length s)))) (subseq x 0 (read-sequence x s)))))
                        (= before (orders c)))))
          (check "ali's code then runs it: two people approved"
                 (and (search "Outcome: done" (text-of (call c "soz_execute" (json:json-nesne "preview_id" id "approval_code" (read-code code-file)))))
                      (= (1+ before) (orders c))))
          (check "the audit record keeps both approvers and ayse's signed token"
                 (with-open-file (s (merge-pathnames "audit.jsonl" *dir*) :external-format :utf-8)
                   (loop for line = (read-line s nil) while line
                         thereis (and (search "\"type\":\"approval\"" line) (search id line)
                                      (search "{\"id\":\"ali\"" line) (search "{\"id\":\"ayse\"" line) (search ayse line))))))
        (close-client c))))

(format t "~%Audit record across restarts~%")
(check "four gateway sessions wrote one audit record, and its chain is intact"
       (let ((sessions 0))
         (with-open-file (s (merge-pathnames "audit.jsonl" *dir*) :external-format :utf-8)
           (loop for line = (read-line s nil) while line
                 when (= 1 (gethash "seq" (json:json-oku line))) do (incf sessions)))
         (and (= sessions 1) (soz:verify-audit (merge-pathnames "audit.jsonl" *dir*)))))

(format t "~%~:[~d FAILED~;All gateway tests passed~]~%" (zerop *failed*) *failed*)
(sb-ext:exit :code (if (zerop *failed*) 0 1))
