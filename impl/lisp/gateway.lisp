;;;; gateway.lisp — soz MCP gateway: an MCP server in front of other MCP servers.
;;;;
;;;; The agent (Claude Desktop, Cursor, any MCP client) connects to the gateway instead of to its MCP
;;;; servers. Tools that only read are passed through. Tools that change something are not offered
;;;; directly: the agent writes a soz plan, the gateway checks and previews it, the user approves the
;;;; preview (through MCP elicitation, which the model cannot answer), and the gateway executes it.
;;;;
;;;; Load after json.lisp, soz.lisp and run.lisp. Entry point: (soz-gateway:main config-path).

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
    (cond ((equal ty "string") :text)
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

(defstruct gateway servers passthrough journal audit (approval "elicitation") (previews (make-hash-table :test #'equal)))

(defun resolve (path base) (and path (namestring (merge-pathnames path base))))

(defun load-config (path)
  "Starts the configured servers and registers their tools. Returns a GATEWAY."
  (let* ((base (make-pathname :name nil :type nil :defaults (truename path)))
         (config (with-open-file (s path :external-format :utf-8)
                   (let ((text (make-string (file-length s)))) (json:json-oku (subseq text 0 (read-sequence text s))))))
         (g (make-gateway :approval (or (gethash "approval" config) "elicitation")
                          :journal (open-journal (resolve (or (gethash "journal" config) "soz-journal.jsonl") base))
                          :audit (make-audit :path (resolve (or (gethash "audit" config) "soz-audit.jsonl") base))))
         (expose-reads (not (eq (gethash "expose_reads" config) :false))))
    (unless (member (gateway-approval g) '("elicitation" "client") :test #'string=)
      (error "approval must be \"elicitation\" or \"client\", not ~s" (gateway-approval g)))
    (setf *operations* (make-hash-table :test #'equal) *implementations* (make-hash-table :test #'equal))
    (maphash (lambda (name spec)
               (let ((s (start-server name spec base)))
                 (handler-case (server-initialize s)
                   (error (e) (log-line "~a" e) (stop-server s) (setf s nil)))
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
               "inputSchema" (input-schema '("plan" "The plan, one (plan \"title\" ...) s-expression.")
                                           '("message" "The user's request, exactly as they wrote it."))
               "annotations" (obj "readOnlyHint" :true))
          (obj "name" "soz_execute"
               "description" "Run a previewed plan. The user is asked to approve the preview first; nothing runs without that approval."
               "inputSchema" (input-schema '("preview_id" "The preview_id returned by soz_preview."))
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

(defun approval-message (p)
  (format nil "~a~%The assistant based this on your message:~%  ~a~%~%Approve these steps?"
          (preview-summary p) (or (soz::preview-message p) "(no message)")))

(defun call-soz-tool (g name args)
  (cond
    ((string= name "soz_guide") (text-result (guide-text)))
    ((string= name "soz_preview")
     (let* ((plan (gethash "plan" args)) (message (gethash "message" args)))
       (if (not (stringp plan))
           (text-result "plan is required" :error t)
           (let ((p (preview plan :message (and (stringp message) message)
                                  :journal (gateway-journal g) :audit (gateway-audit g))))
             (when (preview-hash p) (setf (gethash (preview-hash p) (gateway-previews g)) p))
             (cond ((string= (preview-status p) "invalid")
                    (text-result (error-report (soz::preview-check p)) :error t))
                   ((preview-hash p)
                    (text-result (format nil "~a~%preview_id: ~a~%~%Show the user these steps. Call soz_execute with this preview_id only after they agree; they will be asked to approve in their client."
                                         (preview-summary p) (preview-hash p))
                                 :structured (preview-json p)))
                   (t (text-result (preview-summary p) :error (string= (preview-status p) "error")
                                                       :structured (preview-json p))))))))
    ((string= name "soz_execute")
     (let ((p (find-preview g (gethash "preview_id" args))))
       (cond
         ((null p) (text-result "No preview with that preview_id. Call soz_preview first and use the preview_id it returns." :error t))
         ((soz::preview-used p) (text-result "This preview was already executed. To run the plan again, preview it again; the user approves again." :error t))
         ((string= (gateway-approval g) "elicitation")
          (if (not (and *client-capabilities* (gethash "elicitation" *client-capabilities*)))
              (text-result "This client cannot ask the user for approval (MCP elicitation), and this gateway requires it. Nothing ran." :error t)
              (if (elicit (approval-message p))
                  (text-result (execution-text (execute p (preview-hash p) :journal (gateway-journal g) :audit (gateway-audit g)
                                                                           :approved-by "user (MCP elicitation)")))
                  (text-result "The user did not approve. Nothing ran."))))
         (t (text-result (execution-text (execute p (preview-hash p) :journal (gateway-journal g) :audit (gateway-audit g)
                                                                     :approved-by "user (client tool approval)")))))))
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
