;;;; fake-erp.lisp — A pretend ERP as an MCP server (stdio), for trying the soz gateway.
;;;; It knows one customer and keeps order lines in memory. It does no checking of its own:
;;;; everything it is asked to do, it does. That is the point of putting soz in front of it.

(setf sb-impl::*default-external-format* :utf-8)
(let ((*standard-output* *error-output*))
  (load (merge-pathnames "../../impl/lisp/json.lisp" *load-truename*)))

(defvar *orders* '())

(defun send (m) (write-line (json:json-yaz m) *standard-output*) (finish-output *standard-output*))
(defun text (s &optional error)
  (json:json-nesne "content" (vector (json:json-nesne "type" "text" "text" s)) "isError" (if error :true :false)))
(defun prop (type description) (json:json-nesne "type" type "description" description))
(defun schema (required &rest props)
  (json:json-nesne "type" "object" "properties" (apply #'json:json-nesne props) "required" (coerce required 'vector)))

(defun tools ()
  (vector
   (json:json-nesne "name" "find_customer" "description" "Find a customer by name: code, title, balance and credit limit."
                    "inputSchema" (schema '("name") "name" (prop "string" "Customer name"))
                    "annotations" (json:json-nesne "readOnlyHint" :true))
   (json:json-nesne "name" "list_orders" "description" "All order lines entered so far."
                    "inputSchema" (schema '())
                    "annotations" (json:json-nesne "readOnlyHint" :true))
   (json:json-nesne "name" "add_order_line" "description" "Add a line to an order: the order number comes with the request."
                    "inputSchema" (schema '("order_id" "customer" "product" "quantity")
                                          "order_id" (prop "string" "Order number")
                                          "line_id" (prop "number" "Line number within the order")
                                          "customer" (prop "string" "Customer code")
                                          "product" (prop "string" "Product")
                                          "quantity" (prop "number" "Quantity")
                                          "note" (prop "string" "Free note")))))

(defun call (name args)
  (cond ((equal name "find_customer")
         (if (search "yilmaz" (string-downcase (or (gethash "name" args) "")))
             (text "{\"code\": \"C-1042\", \"title\": \"Yilmaz Market\", \"balance\": 4200, \"limit\": 10000}")
             (text "no such customer" t)))
        ((equal name "list_orders")
         (text (json:json-yaz (coerce (reverse *orders*) 'vector))))
        ((equal name "add_order_line")
         (push (json:json-nesne "order_id" (gethash "order_id" args) "line_id" (or (gethash "line_id" args) :null)
                                "customer" (gethash "customer" args) "product" (gethash "product" args)
                                "quantity" (gethash "quantity" args))
               *orders*)
         ;; It saves the line and then fails at something after it: the tool error does not mean
         ;; the write did not happen.
         (if (equal (gethash "product" args) "lemons")
             (text "order line saved, but its delivery note could not be printed" t)
             (text (format nil "{\"line\": ~d}" (length *orders*)))))
        (t (text "unknown tool" t))))

(loop for line = (read-line *standard-input* nil)
      while line
      do (let* ((m (ignore-errors (json:json-oku line))) (id (and m (gethash "id" m))) (method (and m (gethash "method" m))))
           (when (and id method)
             (send (json:json-nesne
                    "jsonrpc" "2.0" "id" id
                    "result" (cond ((equal method "initialize")
                                    (json:json-nesne "protocolVersion" "2025-06-18"
                                                     "capabilities" (json:json-nesne "tools" (json:json-nesne))
                                                     "serverInfo" (json:json-nesne "name" "fake-erp" "version" "1")))
                                   ((equal method "tools/list") (json:json-nesne "tools" (tools)))
                                   ((equal method "tools/call")
                                    (call (json:json-al m "params" "name")
                                          (or (json:json-al m "params" "arguments") (make-hash-table :test #'equal))))
                                   (t (json:json-nesne))))))))
