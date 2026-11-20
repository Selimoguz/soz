;;;; gateway.lisp — soz MCP gateway: an MCP server in front of other MCP servers.
;;;;
;;;; The agent (Claude Desktop, Cursor, any MCP client) connects to the gateway instead of to its MCP
;;;; servers. Tools that only read are passed through. Tools that change something are not offered
;;;; directly: the agent writes a soz plan, the gateway checks and previews it, the user approves the
;;;; preview (through MCP elicitation, which the model cannot answer), and the gateway executes it.
;;;;
;;;; Load after json.lisp, soz.lisp, run.lisp and ed25519.lisp. Entry point: (soz-gateway:main config-path).

(defpackage :soz-gateway
  (:use :cl :soz)
  (:export #:main #:load-config #:serve))

(in-package :soz-gateway)

(defun log-line (fmt &rest args)
  (format *error-output* "soz-gateway: ~?~%" fmt args)
  (finish-output *error-output*))

(defun jget (h &rest path) (apply #'json:json-al h path))
(defun obj (&rest kv) (apply #'soz::obj kv))
(defun json-line (x) (canonical-json x))

;;; ------------------------------------------------------------------
;;; Downstream MCP servers (stdio)
;;; ------------------------------------------------------------------

(defstruct server name process input (next-id 0) (lines '()) (lock (sb-thread:make-mutex)) (alive t) tools)

(define-condition downstream-timeout (error) ((server :initarg :server :reader timeout-server)))

(defun spawn (command args directory env)
  (let ((environment (append (loop for k being the hash-keys of (or env (make-hash-table)) using (hash-value v)
                                   collect (format nil "~a=~a" k v))
                             (sb-ext:posix-environ))))
    (flet ((run (program arguments)
             (sb-ext:run-program program arguments :search t :wait nil :input :stream :output :stream
                                                    :error nil :directory directory :environment environment
                                                    :external-format :utf-8)))
      (handler-case (run command args)
        (error (e)
          (if (member :win32 *features*)
              (run "cmd" (list* "/c" command args)) ; npx.cmd and friends
              (error e)))))))

(defun start-server (name spec directory)
  (when (and (jget spec "url") (not (jget spec "command")))
    (error "~a: MCP over HTTP needs TLS, which this dependency-free gateway does not have; use the TypeScript gateway (impl/ts) for a server with a url" name))
  (let* ((process (spawn (jget spec "command") (coerce (or (jget spec "args") #()) 'list) directory (jget spec "env")))
         (s (make-server :name name :process process :input (sb-ext:process-input process))))
    (sb-thread:make-thread
     (lambda ()
       (let ((out (sb-ext:process-output process)))
         (loop for line = (handler-case (read-line out nil) (error () nil))
               while line
               do (sb-thread:with-mutex ((server-lock s)) (setf (server-lines s) (append (server-lines s) (list line)))))
         (setf (server-alive s) nil)))
     :name (format nil "soz-gateway reader ~a" name))
    s))

(defun server-send (s message)
  (write-line (json-line message) (server-input s))
  (finish-output (server-input s)))

(defun server-request (s method params &key (timeout 60))
  "Sends a JSON-RPC request and waits for its response. Returns the response object."
  (let ((id (incf (server-next-id s)))
        (deadline (+ (get-internal-real-time) (* timeout internal-time-units-per-second))))
    (server-send s (obj "jsonrpc" "2.0" "id" id "method" method "params" params))
    (loop
      (let ((found nil))
        (sb-thread:with-mutex ((server-lock s))
          (loop while (and (server-lines s) (not found))
                do (let ((m (ignore-errors (json:json-oku (pop (server-lines s))))))
                     (cond ((null m))
                           ((and (equal (gethash "id" m) id) (not (gethash "method" m))) (setf found m))
                           ((and (gethash "method" m) (gethash "id" m)) ; a request from the server: we offer nothing
                            (server-send s (obj "jsonrpc" "2.0" "id" (gethash "id" m)
                                                "error" (obj "code" -32601 "message" "not supported by soz-gateway"))))))))
        (when found (return found))
        (when (or (not (server-alive s)) (> (get-internal-real-time) deadline))
          (error 'downstream-timeout :server (server-name s)))
        (sleep 0.01)))))

(defun server-initialize (s)
  (let ((r (server-request s "initialize" (obj "protocolVersion" "2025-06-18" "capabilities" (obj)
                                              "clientInfo" (obj "name" "soz-gateway" "version" "0.2")))))
    (when (gethash "error" r) (error "~a: initialize failed: ~a" (server-name s) (jget r "error" "message")))
    (server-send s (obj "jsonrpc" "2.0" "method" "notifications/initialized"))
    (let ((tools '()) (cursor nil))
      (loop (let* ((r (server-request s "tools/list" (if cursor (obj "cursor" cursor) (obj))))
                   (page (jget r "result" "tools")))
              (setf tools (append tools (coerce (or page #()) 'list)))
              (setf cursor (jget r "result" "nextCursor"))
              (unless (stringp cursor) (return))))
      (setf (server-tools s) tools))))

(defun stop-server (s)
  (ignore-errors (close (server-input s)))
  (ignore-errors (sb-ext:process-kill (server-process s) 15)))

;;; ------------------------------------------------------------------
;;; Tools -> soz operations
;;; ------------------------------------------------------------------

(defun schema-type (s &key output)
  "JSON Schema -> soz type. Inputs stay flat (text/number/bool/any); outputs may be records and lists."
  (let ((ty (and (hash-table-p s) (gethash "type" s))))
    (cond ((and output (gethash "enum" s) (member ty '("string" "number" "integer") :test #'equal))
           (list :enum (if (equal ty "string") :text :number) (coerce (gethash "enum" s) 'list)))
          ((equal ty "string") :text)
          ((member ty '("number" "integer") :test #'equal) :number)
          ((equal ty "boolean") :bool)
          ((and output (equal ty "array")) (list :list (schema-type (gethash "items" s) :output t)))
          ((and output (equal ty "object") (gethash "required" s) (gethash "properties" s))
           (cons :record (sort (loop for k across (gethash "required" s)
                                     collect (cons (name-fold k) (schema-type (gethash k (gethash "properties" s)) :output t)))
                               #'string< :key #'car)))
          (t :any))))

(defun type-spec (j)
  "A soz type written in the gateway config ({\"type\": ...} as in SPEC 6)."
  (soz::type-from-json j))

(defun tool-operation (server tool overrides)
  "The soz operation for TOOL of SERVER. OVERRIDES (from the config) wins over the tool's own hints."
  (let* ((name (format nil "~a.~a" (server-name server) (gethash "name" tool)))
         (o (and overrides (gethash name overrides)))
         (input (gethash "inputSchema" tool))
         (required (coerce (or (and input (gethash "required" input)) #()) 'list))
         (allowed (coerce (or (and o (gethash "model_allowed" o)) #()) 'list))
         (read-only (eq (jget tool "annotations" "readOnlyHint") :true))
         (effect (or (and o (gethash "effect" o)) (if read-only "read" "write")))
         (params (let ((props (and input (gethash "properties" input))) (out '()))
                   (when props
                     (maphash (lambda (k v)
                                (push (soz::make-param :name k :type (schema-type v)
                                                       :required (and (member k required :test #'string=) t)
                                                       :model-allowed (and (member k allowed :test #'string=) t))
                                      out))
                              props))
                   (sort out #'string< :key #'soz::pa-name))))
    (soz::make-operation :name name :effect effect :params params
                         :returns (cond ((and o (gethash "returns" o)) (type-spec (gethash "returns" o)))
                                        ((gethash "outputSchema" tool) (schema-type (gethash "outputSchema" tool) :output t))
                                        (t :any))
                         :key (and o (gethash "key" o) (coerce (gethash "key" o) 'list)))))

(defun tool-result-value (r)
  "The value of a tools/call result: structuredContent, else the text parsed as JSON, else the text."
  (or (gethash "structuredContent" r)
      (let ((text (format nil "~{~a~^~%~}" (loop for c across (or (gethash "content" r) #())
                                                 when (equal (gethash "type" c) "text") collect (gethash "text" c)))))
        (or (handler-case (let ((v (json:json-oku text))) (if (eq v :null) nil v)) (error () nil))
            text))))

(defun result-text (r)
  (format nil "~{~a~^~%~}" (loop for c across (or (gethash "content" r) #())
                                 when (equal (gethash "type" c) "text") collect (gethash "text" c))))

(defun call-tool (server tool args)
  "Implementation of a soz operation: failed on a tool error, unknown when the server does not answer."
  (let ((response (handler-case (server-request server "tools/call" (obj "name" tool "arguments" args))
                    (downstream-timeout ()
                      (error 'operation-unknown :message (format nil "~a did not answer" (server-name server)))))))
    (cond ((gethash "error" response)
           (error 'operation-failed :message (or (jget response "error" "message") "error")))
          ((eq (jget response "result" "isError") :true)
           (error 'operation-failed :message (result-text (gethash "result" response))))
          (t (tool-result-value (gethash "result" response))))))

;;; ------------------------------------------------------------------
;;; Configuration
;;; ------------------------------------------------------------------

(defstruct gateway servers passthrough journal audit (approval "auto") (previews (make-hash-table :test #'equal))
  (codes (make-hash-table :test #'equal)) policy actor approvers requests-dir profile (signed (make-hash-table :test #'equal)))

(defun resolve (path base) (and path (namestring (merge-pathnames path base))))

(defun load-config (path)
  "Starts the configured servers and registers their tools. Returns a GATEWAY."
  (let* ((base (make-pathname :name nil :type nil :defaults (truename path)))
         (config (with-open-file (s path :external-format :utf-8)
                   (let ((text (make-string (file-length s)))) (json:json-oku (subseq text 0 (read-sequence text s))))))
         (g (make-gateway :approval (or (gethash "approval" config) "auto")
                          :journal (open-journal (resolve (or (gethash "journal" config) "soz-journal.jsonl") base))
                          :audit (open-audit (resolve (or (gethash "audit" config) "soz-audit.jsonl") base))))
         (expose-reads (not (eq (gethash "expose_reads" config) :false))))
    (when (stringp (gethash "profile" config))   ; a language profile, SPEC 5.4
      (setf (gateway-profile g)
            (profile-from-json (with-open-file (s (resolve (gethash "profile" config) base) :external-format :utf-8)
                                 (let ((text (make-string (file-length s)))) (json:json-oku (subseq text 0 (read-sequence text s))))))))
    (setf (gateway-approvers g) (approvers-from-json (gethash "approvers" config))
          (gateway-requests-dir g) (let ((d (resolve (or (gethash "approval_requests" config) "soz-approval-requests") base)))
                                     (if (char= (char d (1- (length d))) #\/) d (concatenate 'string d "/"))))
    (setf (gateway-actor g) (actor-from-json (gethash "actor" config))
          (gateway-policy g) (let ((pol (gethash "policy" config)))
                               (cond ((stringp pol)   ; a file next to the config
                                      (with-open-file (s (resolve pol base) :external-format :utf-8)
                                        (let ((text (make-string (file-length s))))
                                          (policy-from-json (json:json-oku (subseq text 0 (read-sequence text s)))))))
                                     (pol (policy-from-json pol))
                                     (t '()))))
    (unless (member (gateway-approval g) '("auto" "elicitation" "code" "client") :test #'string=)
      (error "approval must be \"auto\", \"elicitation\", \"code\" or \"client\", not ~s" (gateway-approval g)))
    (setf *operations* (make-hash-table :test #'equal) *implementations* (make-hash-table :test #'equal))
    (maphash (lambda (name spec)
               (let ((s (handler-case (start-server name spec base)
                          (error (e) (log-line "~a" e) nil))))   ; a server that cannot start is left out
                 (when s
                   (handler-case (server-initialize s)
                     (error (e) (log-line "~a" e) (stop-server s) (setf s nil))))
                 (when s
                   (push s (gateway-servers g))
                   (dolist (tool (server-tools s))
                     (let ((op (tool-operation s tool (gethash "operations" config)))
                           (tool-name (gethash "name" tool)) (srv s))
                       (setf (gethash (name-fold (soz::op-name op)) *operations*) op
                             (gethash (name-fold (soz::op-name op)) *implementations*)
                             (lambda (args) (call-tool srv tool-name args)))
                       (when (and expose-reads (not (soz::side-effect-p (soz::op-effect op))))
                         (push (list (format nil "~a_~a" name tool-name) s tool) (gateway-passthrough g)))))
                   (log-line "~a: ~d tools" name (length (server-tools s))))))
             (or (gethash "servers" config) (make-hash-table)))
    g))

;;; ------------------------------------------------------------------
;;; What the model sees
;;; ------------------------------------------------------------------

(defun type-label (type)
  (cond ((keywordp type) (string-downcase (symbol-name type)))
        ((eq (first type) :enum) (soz::type-name type))
        ((eq (first type) :list) (format nil "list of ~a" (type-label (second type))))
        (t (format nil "record {~{~a~^, ~}}" (mapcar (lambda (f) (format nil "~a: ~a" (car f) (type-label (cdr f)))) (rest type))))))

(defun operations-text ()
  (with-output-to-string (o)
    (dolist (op (sort (loop for op being the hash-values of *operations* collect op) #'string< :key #'soz::op-name))
      (format o "- (~a~{ ~a~})  effect: ~a~@[; returns ~a~]~%" (soz::op-name op)
              (mapcar (lambda (p) (format nil "~a <~a~:[, optional~;~]~:[~;, your own text allowed~]>"
                                          (soz::pa-name p) (type-label (soz::pa-type p)) (soz::pa-required p) (soz::pa-model-allowed p)))
                      (soz::op-params op))
              (soz::op-effect op)
              (unless (eq (soz::op-returns op) :any) (type-label (soz::op-returns op)))))))

(defun guide-text ()
  (format nil "soz plans: how to change anything through this gateway.

Tools that only read can be called directly. Everything that changes something (writes, sends,
pays) goes through a plan: call soz_preview with the plan and the user's message, show the user
the preview, and call soz_execute only after they agree. The user approves in their own client;
you cannot approve for them.

A plan is one s-expression:

  (plan \"title\" EXPR ...)

Forms: (let ((name EXPR) ...) BODY...)   (for-each (name LIST) BODY...)   (if COND THEN [ELSE])
       (do EXPR ...)   (stop \"reason\" ...)   (list EXPR ...)   (record field EXPR ...)
       (get RECORD field)   + - * /   = != < > <= >=   and or not
Calls:  (operation param EXPR param EXPR ...)   ; parameters by name, in any order
Values: \"text\", numbers like 20 or 12.5, names bound by let or for-each. Nothing else: no quotes,
        no #, no colons.

Rules the checker enforces (it explains every error with line and column):
- Every number and text you write in the plan must appear in the user's message, or come from an
  operation's result. A value you made up cannot go to an operation that changes something, and
  such an operation cannot sit under an `if` whose condition contains a made-up value. If you do
  not know a value, look it up with a read, or stop and ask: (stop \"Which customer?\").
- Pass the user's message to soz_preview exactly as they wrote it.
- Loops run only over lists, at most 50 items.
- The same plan may be written as JSON instead: {\"plan\": \"title\", \"body\": [...]}, with
  {\"call\": \"erp.find_customer\", \"args\": [{\"name\": \"name\", \"value\": \"Yilmaz Market\"}]},
  {\"var\": \"c\"}, {\"get\": {\"var\": \"c\"}, \"field\": \"code\"}, {\"op\": \">\", \"args\": [...]} and so on (SPEC 2.1).

Operations:
~a
Example:
  (plan \"Order for Yilmaz Market\"
    (let ((c (erp.find_customer name \"Yilmaz Market\")))
      (if (> (get c balance) (get c limit))
          (stop \"Yilmaz Market is over its credit limit\")
          (for-each (line (list (record product \"tomatoes\" quantity 20)
                                (record product \"peppers\" quantity 5)))
            (erp.add_order_line customer (get c code) product (get line product)
                                quantity (get line quantity))))))
(The operation names above are the ones this gateway really has; the example's may differ.)"
          (operations-text)))

(defun input-schema (&rest props)
  "PROPS: (name description) ...; all required strings."
  (obj "type" "object"
       "properties" (cons :object (loop for (n d) in props collect (cons n (obj "type" "string" "description" d))))
       "required" (coerce (mapcar #'first props) 'vector)))

(defun tool-list (g)
  (coerce
   (append
    (list (obj "name" "soz_guide" "description" "How to write a soz plan, and the operations available. Read this before your first plan."
               "inputSchema" (obj "type" "object" "properties" (obj))
               "annotations" (obj "readOnlyHint" :true))
          (obj "name" "soz_preview"
               "description" "Check a soz plan and preview it: reads run, nothing is changed. Returns the steps the plan would take and a preview_id, or the errors to fix."
               "inputSchema" (input-schema '("plan" "The plan, one (plan \"title\" ...) s-expression, or the same plan as JSON {\"plan\": \"title\", \"body\": [...]}.")
                                           '("message" "The user's request, exactly as they wrote it."))
               "annotations" (obj "readOnlyHint" :true))
          (obj "name" "soz_execute"
               "description" "Run a previewed plan. The user approves it first: in their client, or by telling you the approval code shown to them outside the chat. Nothing runs without that approval."
               "inputSchema" (obj "type" "object"
                                  "properties" (obj "preview_id" (obj "type" "string" "description" "The preview_id returned by soz_preview.")
                                                    "approval_code" (obj "type" "string" "description" "Only the code the user told you. Never guess it.")
                                                    "approvals" (obj "type" "array" "items" (obj "type" "string")
                                                                     "description" "Approval tokens (soz1....) other people gave the user, when the plan needs their approval. Only tokens the user gave you."))
                                  "required" (vector "preview_id"))
               "annotations" (obj "readOnlyHint" :false "destructiveHint" :true)))
    (loop for (name nil tool) in (reverse (gateway-passthrough g))
          collect (obj "name" name "description" (or (gethash "description" tool) "")
                       "inputSchema" (or (gethash "inputSchema" tool) (obj "type" "object"))
                       "annotations" (obj "readOnlyHint" :true))))
   'vector))

(defun text-result (text &key error structured)
  (let ((r (list "content" (vector (obj "type" "text" "text" text)) "isError" (if error :true :false))))
    (apply #'obj (if structured (append r (list "structuredContent" structured)) r))))

;;; ------------------------------------------------------------------
;;; The MCP server side
;;; ------------------------------------------------------------------

(defvar *in*)
(defvar *out*)
(defvar *pending* '() "Messages read from the client while waiting for an elicitation answer.")
(defvar *client-capabilities* nil)
(defvar *elicit-id* 0)

(defun send (message) (write-line (json-line message) *out*) (finish-output *out*))

(defun next-message ()
  (if *pending*
      (pop *pending*)
      (let ((line (read-line *in* nil)))
        (cond ((null line) :eof)
              ((string= (string-trim " " line) "") (next-message))
              (t (handler-case (json:json-oku line) (error () (next-message))))))))

(defun elicit (message)
  "Asks the user through the client (MCP elicitation). T only if they explicitly approve."
  (let ((id (format nil "soz-elicit-~d" (incf *elicit-id*))))
    (send (obj "jsonrpc" "2.0" "id" id "method" "elicitation/create"
               "params" (obj "message" message
                             "requestedSchema" (obj "type" "object"
                                                    "properties" (obj "approve" (obj "type" "boolean" "title" "Approve"
                                                                                     "description" "Run exactly these steps"))
                                                    "required" (vector "approve")))))
    (loop
      (let ((line (read-line *in* nil)))
        (unless line (return nil))
        (let ((m (ignore-errors (json:json-oku line))))
          (cond ((null m))
                ((and (equal (gethash "id" m) id) (not (gethash "method" m)))
                 (return (and (equal (jget m "result" "action") "accept")
                              (eq (jget m "result" "content" "approve") :true))))
                (t (setf *pending* (append *pending* (list m))))))))))

(defun find-preview (g id)
  (when (and (stringp id) (>= (length id) 12))
    (let ((hits (loop for k being the hash-keys of (gateway-previews g) using (hash-value p)
                      when (and (<= (length id) (length k)) (string= id k :end2 (length id))) collect p)))
      (and (= (length hits) 1) (first hits)))))

(defun execution-text (e)
  (format nil "Outcome: ~a~@[ — ~a~]~@[~%The plan stopped: ~a~]~%Steps: ~{~a~^, ~}"
          (execution-outcome e) (execution-message e) (execution-stop-reason e)
          (mapcar (lambda (s) (format nil "~d ~a" (step-index s) (step-status s))) (execution-steps e))))

(defun approval-message (g p)
  (format nil "~a~a~%The assistant based this on your message:~%  ~a~%~%Approve these steps?"
          (preview-summary p) (also-approved g p) (soz::visible (or (soz::preview-message p) "(no message)"))))

;;; --- Other people's approval (SPEC 11.6): signed tokens, verified with the approvers' public keys

(defstruct approver actor public-key)

(defun approvers-from-json (j)
  (loop for a across (or j #())
        collect (let ((id (and (hash-table-p a) (gethash "id" a)))
                      (key (and (hash-table-p a) (stringp (gethash "public_key" a)) (soz-ed25519:base64url-decode (gethash "public_key" a)))))
                  (unless (and (stringp id) (plusp (length id)) (notany (lambda (c) (member c '(#\Space #\Tab #\Newline #\Return))) id)
                               (vectorp (gethash "roles" a)))
                    (error "an approver needs an id without spaces, roles and a public_key: ~a" (soz::canonical-json a)))
                  (unless (and key (= (length key) 32) (soz-ed25519::decode-point key))
                    (error "the public_key of ~a is not an Ed25519 key" id))
                  (make-approver :actor (make-actor :id id :roles (coerce (gethash "roles" a) 'list)) :public-key key))))

(defun approver-id (a) (actor-id (approver-actor a)))

(defun unix-now () (- (get-universal-time) (encode-universal-time 0 0 0 1 1 1970 0)))

(defun verify-token (g token hash)
  "The approver TOKEN proves for HASH, or NIL and why not."
  (let* ((s (string-trim '(#\Space #\Tab #\Newline #\Return) token))
         (dot3 (position #\. s :from-end t))
         (dot2 (and dot3 (position #\. s :from-end t :end dot3)))
         (id (and dot2 (> dot2 5) (string= "soz1." s :end2 5) (subseq s 5 dot2)))
         (exp (and id (every #'digit-char-p (subseq s (1+ dot2) dot3)) (< 0 (- dot3 dot2 1) 13)
                   (parse-integer s :start (1+ dot2) :end dot3)))
         (sig (and exp (= (- (length s) dot3 1) 86) (soz-ed25519:base64url-decode (subseq s (1+ dot3))))))
    (cond ((or (null sig) (some (lambda (c) (member c '(#\Space #\Tab #\Newline #\Return))) id))
           (values nil "this is not a soz approval token"))
          (t (let ((a (find id (gateway-approvers g) :key #'approver-id :test #'string=)))
               (cond ((null a) (values nil (format nil "~a is not an approver of this gateway" id)))
                     ((not (soz-ed25519:ed25519-verify
                            (approver-public-key a)
                            (sb-ext:string-to-octets (format nil "soz approval 1~%~a~%~a~%~d" hash id exp) :external-format :utf-8)
                            sig))
                      (values nil (format nil "the token is not ~a's approval of this preview" id)))
                     ((< exp (unix-now)) (values nil (format nil "~a's approval has expired" id)))
                     (t (values a nil))))))))

(defun requirements-of (p)
  (remove-duplicates (loop for st in (preview-steps p) unless (step-already-done st) append (step-requires st)) :test #'equal))

(defun signed-of (g p) (gethash (preview-hash p) (gateway-signed g)))

(defun approvers-of (g p)
  "The user and everyone whose signed approval of P the gateway has accepted."
  (append (and (gateway-actor g) (list (gateway-actor g)))
          (mapcar (lambda (x) (approver-actor (car x))) (signed-of g p))))

(defun also-approved (g p)
  (let ((s (signed-of g p)))
    (if s
        (format nil "Also approved by: ~{~a~^, ~}~%"
                (mapcar (lambda (x) (format nil "~a (~{~a~^, ~})" (approver-id (car x)) (actor-roles (approver-actor (car x))))) s))
        "")))

(defun accept-tokens (g p given)
  "Takes the tokens the model passed on; returns notes on those it could not accept, and why."
  (let ((notes '()) (actor (gateway-actor g)))
    (dolist (tok (cond ((vectorp given) (coerce given 'list)) ((stringp given) (list given)) (t '())))
      (when (stringp tok)
        (multiple-value-bind (a why) (verify-token g tok (preview-hash p))
          (cond
            ((null a) (push (format nil "Not accepted: ~a." why) notes))
            ((and actor (string= (approver-id a) (actor-id actor)))
             (push (format nil "Not accepted: ~a is the user, who approves in their own approval window, not by a token." (approver-id a)) notes))
            ((notany (lambda (r) (member (first r) (actor-roles (approver-actor a)) :test #'string=)) (requirements-of p))
             (push (format nil "Not accepted: this plan needs no approval ~a can give (~a: ~:[no roles~;~:*~{~a~^, ~}~])."
                           (approver-id a) (approver-id a) (actor-roles (approver-actor a)))
                   notes))
            ((find (approver-id a) (signed-of g p) :key (lambda (x) (approver-id (car x))) :test #'string=))
            (t (setf (gethash (preview-hash p) (gateway-signed g))
                     (append (signed-of g p) (list (cons a (string-trim '(#\Space #\Tab #\Newline #\Return) tok))))))))))
    (reverse notes)))

(defun approval-request-json (g p unmet)
  (soz::canonical-json
   (obj "soz_approval_request" 1 "hash" (preview-hash p) "plan" (soz::preview-text p)
        "message" (or (soz::preview-message p) :null)
        "steps" (map 'vector (lambda (s) (obj "operation" (soz::op-name (step-operation s)) "args" (soz::step-args s) "key" (soz::step-key s)))
                     (preview-steps p))
        "created" (multiple-value-bind (s mi h d mo y) (decode-universal-time (get-universal-time) 0)
                    (format nil "~d-~2,'0d-~2,'0dT~2,'0d:~2,'0d:~2,'0dZ" y mo d h mi s))
        "actor" (if (gateway-actor g)
                    (obj "id" (actor-id (gateway-actor g)) "roles" (coerce (actor-roles (gateway-actor g)) 'vector))
                    :null)
        "requires" (map 'vector (lambda (r) (obj "role" (first r) "four_eyes" (if (second r) :true :false) "rule" (third r))) unmet))))

(defun ask-others (g p unmet notes)
  "Writes an approval request for the people P still needs, and says who they are."
  (let* ((actor (gateway-actor g))
         (who (mapcar (lambda (r)
                        (destructuring-bind (role four-eyes rule) r
                          (declare (ignore rule))
                          (let ((can (loop for a in (gateway-approvers g)
                                           when (and (member role (actor-roles (approver-actor a)) :test #'string=)
                                                     (not (and four-eyes actor (string= (approver-id a) (actor-id actor)))))
                                             collect (approver-id a))))
                            (format nil "- approval by ~a~:[~*~; (someone other than ~a)~]: ~:[nobody among this gateway's approvers has this role~;~:*~{~a~^, ~}~]"
                                    role (and four-eyes actor) (and actor (actor-id actor)) can))))
                      unmet))
         (path (namestring (merge-pathnames (format nil "~a.json" (subseq (preview-hash p) 0 16))
                                            (gateway-requests-dir g)))))
    (handler-case
        (progn (ensure-directories-exist path)
               (with-open-file (s path :direction :output :if-exists :supersede :external-format :utf-8)
                 (write-string (approval-request-json g p unmet) s) (terpri s)))
      (error (e) (return-from ask-others (text-result (format nil "Could not write the approval request: ~a. Nothing ran." e) :error t))))
    (text-result (format nil "~{~a~%~}This plan also needs the approval of other people:~%~{~a~^~%~}~%~%An approval request was written to:~%  ~a~%~%Tell the user: give this file to one of the people named above. They open it with soz-approve on their own machine, check the steps and, if they agree, give back an approval token (soz1....). When the user gives you the token, call soz_execute again with preview_id and approvals. You cannot make or change a token. Nothing ran."
                         notes who path)
                 :error t)))

(defun run-approved (g p by)
  (execute p (preview-hash p) :journal (gateway-journal g) :audit (gateway-audit g) :approved-by by
                              :approvers (approvers-of g p) :signatures (mapcar #'cdr (signed-of g p))))

;;; --- Approval codes: shown to the user outside the chat, typed back by the user

(defparameter *code-alphabet* "ACDEFHJKLMNPRTUVWXY3479")
(defparameter *code-lifetime* 600 "Seconds an approval code stays valid.")
(defparameter *code-attempts* 3 "Wrong codes allowed before the preview is locked.")
(defvar *code-random* (make-random-state t))

(defstruct pending-code code expires (wrong 0))

(defun client-elicits-p () (and *client-capabilities* (gethash "elicitation" *client-capabilities*) t))

(defun code-mode-p (g)
  (or (string= (gateway-approval g) "code")
      (and (string= (gateway-approval g) "auto") (not (client-elicits-p)))))

(defun new-code ()
  (let ((c (coerce (loop repeat 6 collect (char *code-alphabet* (random (length *code-alphabet*) *code-random*))) 'string)))
    (format nil "~a-~a" (subseq c 0 3) (subseq c 3))))

(defun normalize-code (s)
  (string-upcase (remove-if-not #'alphanumericp (or s ""))))

(defun base64 (text)
  (let* ((bytes (sb-ext:string-to-octets text :external-format :utf-8))
         (n (length bytes))
         (abc "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"))
    (with-output-to-string (o)
      (loop for i from 0 below n by 3
            do (let* ((b0 (aref bytes i))
                      (b1 (if (< (+ i 1) n) (aref bytes (+ i 1)) 0))
                      (b2 (if (< (+ i 2) n) (aref bytes (+ i 2)) 0))
                      (v (logior (ash b0 16) (ash b1 8) b2)))
                 (write-char (char abc (ldb (byte 6 18) v)) o)
                 (write-char (char abc (ldb (byte 6 12) v)) o)
                 (write-char (if (< (+ i 1) n) (char abc (ldb (byte 6 6) v)) (code-char 61)) o)
                 (write-char (if (< (+ i 2) n) (char abc (ldb (byte 6 0) v)) (code-char 61)) o))))))

(defun show-to-user (title text)
  "Shows TEXT in a window of its own, on the user's screen, outside the chat. The text reaches the
window through the program's standard input, never on a command line. T if a window was opened.
SOZ_TEST_CODE_FILE (tests only) writes the text to that file instead."
  (let ((test-file (sb-ext:posix-getenv "SOZ_TEST_CODE_FILE")))
    (when (and test-file (plusp (length test-file)))
      (with-open-file (s test-file :direction :output :if-exists :supersede :external-format :utf-8)
        (write-string text s))
      (return-from show-to-user t)))
  (flet ((run (program args script)
           (handler-case
               (let ((p (sb-ext:run-program program args :search t :wait nil :input :stream :output nil :error nil
                                                         :external-format :utf-8)))
                 (write-string script (sb-ext:process-input p))
                 (close (sb-ext:process-input p))
                 t)
             (error (e) (log-line "could not show the approval window: ~a" e) nil))))
    (cond
      ((member :win32 *features*)
       (run "powershell" '("-NoProfile" "-NonInteractive" "-Sta" "-Command" "-")
            (format nil "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('~a'))~%$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('~a'))~%Add-Type -AssemblyName System.Windows.Forms~%[void][System.Windows.Forms.MessageBox]::Show($t,$h,'OK','Information','Button1','DefaultDesktopOnly')~%"
                    (base64 text) (base64 title))))
      ((member :darwin *features*)
       (let ((q (code-char 34)) (sq (code-char 39)))
         (run "osascript" '()
              (format nil "display dialog ~a~a~a with title ~a~a~a buttons {~aOK~a} default button 1~%"
                      q (substitute sq q text) q q (substitute sq q title) q q q))))
      (t nil))))

(defun code-window-text (g p code)
  (format nil "Approval code: ~a~%~%~a~a~%The assistant based this on your message:~%  ~a~%~%If you agree, type this code in the chat. If not, ignore it.~%The code works once and expires in ~d minutes."
          code (preview-summary p) (also-approved g p) (soz::visible (or (soz::preview-message p) "(no message)")) (floor *code-lifetime* 60)))

(defun execute-with-code (g p given)
  (let ((pending (gethash (preview-hash p) (gateway-codes g)))
        (now (get-universal-time)))
    (cond
      ((and pending (eq (pending-code-code pending) :locked))
       (text-result "Too many wrong approval codes for this preview; it is locked. Preview the plan again." :error t))
      ((zerop (length (normalize-code given)))
       (let ((code (new-code)))
         (if (show-to-user "soz: approve these steps?" (code-window-text g p code))
             (progn
               (setf (gethash (preview-hash p) (gateway-codes g))
                     (make-pending-code :code code :expires (+ now *code-lifetime*)))
               (text-result "An approval code is now shown to the user in a window outside this chat. Ask them to read the steps there and, if they agree, to tell you the code. Then call soz_execute again with preview_id and approval_code. Nothing has run."))
             (text-result "Could not show the approval code to the user on this system. Nothing ran." :error t))))
      ((null pending)
       (text-result "No approval code was issued for this preview. Call soz_execute with only the preview_id first; the user is then shown a code." :error t))
      ((> now (pending-code-expires pending))
       (remhash (preview-hash p) (gateway-codes g))
       (text-result "The approval code expired. Call soz_execute with only the preview_id to show the user a new one. Nothing ran." :error t))
      ((string= (normalize-code given) (normalize-code (pending-code-code pending)))
       (remhash (preview-hash p) (gateway-codes g))
       (text-result (execution-text (run-approved g p "user (approval code)"))))
      (t
       (incf (pending-code-wrong pending))
       (if (>= (pending-code-wrong pending) *code-attempts*)
           (progn (setf (pending-code-code pending) :locked)
                  (text-result "Wrong approval code, too many times; this preview is locked. Nothing ran." :error t))
           (text-result (format nil "Wrong approval code. Nothing ran. Ask the user to check the code in their window (~d tries left)."
                                (- *code-attempts* (pending-code-wrong pending)))
                        :error t))))))

(defun unmet-here (g p)
  "Requirements of P's steps that the gateway's own user cannot meet alone."
  (soz::unmet-requirements (requirements-of p) (approvers-of g p) (gateway-actor g)))

(defun policy-text (g)
  (if (null (gateway-policy g))
      ""
      (format nil "~%Policy in force~@[ for ~a~]:~%~{- ~a~%~}"
              (and (gateway-actor g) (format nil "~a (~{~a~^, ~})" (actor-id (gateway-actor g)) (actor-roles (gateway-actor g))))
              (mapcar (lambda (r) (soz::rule-name r)) (gateway-policy g)))))

(defun call-soz-tool (g name args)
  (cond
    ((string= name "soz_guide") (text-result (concatenate 'string (guide-text) (policy-text g))))
    ((string= name "soz_preview")
     (let* ((plan (gethash "plan" args)) (message (gethash "message" args)))
       (if (not (stringp plan))
           (text-result "plan is required" :error t)
           (let ((p (preview plan :message (and (stringp message) message)
                                  :journal (gateway-journal g) :audit (gateway-audit g)
                                  :policy (gateway-policy g) :actor (gateway-actor g) :profile (gateway-profile g))))
             (when (preview-hash p) (setf (gethash (preview-hash p) (gateway-previews g)) p))
             (cond ((string= (preview-status p) "invalid")
                    (text-result (error-report (soz::preview-check p)) :error t))
                   ((string= (preview-status p) "denied")
                    (text-result (format nil "~a~%The policy does not allow this plan. Tell the user why; do not try to get around it."
                                         (preview-summary p))
                                 :error t))
                   ((preview-hash p)
                    (text-result (format nil "~a~%preview_id: ~a~%~%Show the user these steps. Call soz_execute with this preview_id only after they agree; ~a"
                                         (preview-summary p) (preview-hash p)
                                         (if (code-mode-p g)
                                             "the user is then shown an approval code outside this chat, and you ask them for it."
                                             "they will be asked to approve in their client."))))
                   (t (text-result (preview-summary p) :error (string= (preview-status p) "error"))))))))
    ((string= name "soz_execute")
     (let ((p (find-preview g (gethash "preview_id" args))))
       (cond
         ((null p) (text-result "No preview with that preview_id. Call soz_preview first and use the preview_id it returns." :error t))
         ((soz::preview-used p) (text-result "This preview was already executed. To run the plan again, preview it again; the user approves again." :error t))
         ((let ((notes (accept-tokens g p (gethash "approvals" args))))
            (when (unmet-here g p)
              (if (gateway-approvers g)
                  (ask-others g p (unmet-here g p) notes)
                  (text-result (format nil "This plan needs ~a. This gateway can only collect the approval of ~a. Nothing ran."
                                       (soz::requirements-text (unmet-here g p) (gateway-actor g))
                                       (if (gateway-actor g) (actor-id (gateway-actor g)) "the user"))
                               :error t)))))
         ((code-mode-p g) (execute-with-code g p (gethash "approval_code" args)))
         ((member (gateway-approval g) '("elicitation" "auto") :test #'string=)
          (if (not (client-elicits-p))
              (text-result "This client cannot ask the user for approval (MCP elicitation), and this gateway requires it. Nothing ran." :error t)
              (if (elicit (approval-message g p))
                  (text-result (execution-text (run-approved g p "user (MCP elicitation)")))
                  (text-result "The user did not approve. Nothing ran."))))
         (t (text-result (execution-text (run-approved g p "user (client tool approval)")))))))
    (t
     (let ((pass (find name (gateway-passthrough g) :key #'first :test #'string=)))
       (if (not pass)
           (text-result (format nil "Unknown tool ~a. Changes go through soz_preview and soz_execute." name) :error t)
           (destructuring-bind (server tool) (rest pass)
             (let ((r (handler-case (server-request server "tools/call" (obj "name" (gethash "name" tool) "arguments" (or args (obj))))
                        (downstream-timeout () nil))))
               (cond ((null r) (text-result (format nil "~a did not answer." (server-name server)) :error t))
                     ((gethash "error" r) (text-result (or (jget r "error" "message") "error") :error t))
                     (t (gethash "result" r))))))))))

(defun handle (g m)
  (let ((method (gethash "method" m)) (id (gethash "id" m)) (params (gethash "params" m)))
    (flet ((reply (result) (send (obj "jsonrpc" "2.0" "id" id "result" result)))
           (fail (code message) (send (obj "jsonrpc" "2.0" "id" id "error" (obj "code" code "message" message)))))
      (cond
        ((null method) nil)                      ; a response to something we did not ask
        ((null id) nil)                          ; notifications
        ((string= method "initialize")
         (setf *client-capabilities* (and params (gethash "capabilities" params)))
         (reply (obj "protocolVersion" (or (and params (gethash "protocolVersion" params)) "2025-06-18")
                     "capabilities" (obj "tools" (obj))
                     "serverInfo" (obj "name" "soz-gateway" "version" "0.2")
                     "instructions" "Changes go through soz plans: read soz_guide, then soz_preview, then soz_execute after the user agrees.")))
        ((string= method "ping") (reply (obj)))
        ((string= method "tools/list") (reply (obj "tools" (tool-list g))))
        ((string= method "tools/call")
         (reply (handler-case (call-soz-tool g (gethash "name" params) (or (gethash "arguments" params) (make-hash-table :test #'equal)))
                  (error (e) (text-result (format nil "soz-gateway error: ~a" e) :error t)))))
        (t (fail -32601 (format nil "method not found: ~a" method)))))))

(defun serve (g &key (in *standard-input*) (out *standard-output*))
  (let ((*in* in) (*out* out) (*pending* '()) (*client-capabilities* nil))
    (loop for m = (next-message)
          until (eq m :eof)
          do (handle g m))))

(defun main (config-path)
  (let ((g (let ((*standard-output* *error-output*)) (load-config config-path))))
    (unwind-protect (serve g)
      (mapc #'stop-server (gateway-servers g)))))
