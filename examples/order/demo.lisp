;;;; demo.lisp — The whole loop on a pretend ERP: check, preview, approve, execute, journal, audit.
;;;; sbcl --script examples/order/demo.lisp
;;;; Writes demo-journal.jsonl and demo-audit.jsonl next to this file (deleted at the start).

(setf sb-impl::*default-external-format* :utf-8)
(defvar cl-user::*here* (make-pathname :name nil :type nil :defaults *load-truename*))
(dolist (f '("json" "soz" "run"))
  (load (merge-pathnames (format nil "../../impl/lisp/~a.lisp" f) cl-user::*here*)))

(defpackage :soz-demo (:use :cl :soz))
(in-package :soz-demo)

(defun read-file (path)
  (with-open-file (s path :external-format :utf-8)
    (let ((text (make-string (file-length s)))) (subseq text 0 (read-sequence text s)))))

(defun json-file (path) (json:json-oku (read-file path)))

;;; The pretend ERP: one customer, an order book in memory.
(defvar *orders* '())

(map nil #'operation-from-json (json-file (merge-pathnames "operations.json" cl-user::*here*)))

(define-implementation erp.find_customer (args)
  (declare (ignore args))
  (json:json-nesne "code" "C-1042" "title" "Yilmaz Market" "balance" 4200 "limit" 10000))

(define-implementation erp.add_order_line (args)
  (push (list (gethash "customer" args) (gethash "product" args) (gethash "quantity" args)) *orders*)
  (json:json-nesne "line" (length *orders*)))

(defun banner (text) (format t "~%=== ~a ===~%" text))

(let ((journal-path (merge-pathnames "demo-journal.jsonl" cl-user::*here*))
      (audit-path (merge-pathnames "demo-audit.jsonl" cl-user::*here*))
      (message (string-trim '(#\Newline #\Return) (read-file (merge-pathnames "message.txt" cl-user::*here*)))))
  (dolist (p (list journal-path audit-path)) (when (probe-file p) (delete-file p)))
  (let ((journal (open-journal journal-path))
        (audit (make-audit :path audit-path)))
    (format t "Message: ~a~%" message)

    (banner "1. A plan with a quantity and a product nobody asked for")
    (format t "~a" (preview-summary (preview (read-file (merge-pathnames "invented.soz" cl-user::*here*))
                                             :message message :journal journal :audit audit)))

    (banner "2. The model fixes it: preview (reads run, nothing is written)")
    (let ((p (preview (read-file (merge-pathnames "good.soz" cl-user::*here*)) :message message :journal journal :audit audit)))
      (format t "~a" (preview-summary p))
      (format t "Order lines in the ERP so far: ~d~%" (length *orders*))

      (banner "3. The person approves; execution does exactly that")
      (let ((e (execute p (preview-hash p) :journal journal :audit audit :approved-by "demo user")))
        (format t "Outcome: ~a~%Order lines in the ERP now: ~{~a~^; ~}~%" (execution-outcome e) (reverse *orders*))))

    (banner "4. The same plan again (a retry, a double click, a duplicated message)")
    (let ((p (preview (read-file (merge-pathnames "good.soz" cl-user::*here*)) :message message :journal journal :audit audit)))
      (format t "~a" (preview-summary p))
      (let ((e (execute p (preview-hash p) :journal journal :audit audit :approved-by "demo user")))
        (format t "Outcome: ~a; steps: ~{~a~^, ~}~%Order lines in the ERP: ~d (nothing twice)~%"
                (execution-outcome e) (mapcar #'step-status (execution-steps e)) (length *orders*))))

    (banner "5. The audit record")
    (format t "~a: ~d lines, chain ~:[BROKEN~;intact~]~%" (file-namestring audit-path)
            (length (audit-lines audit)) (verify-audit audit-path))
    (let* ((lines (reverse (audit-lines audit)))
           (forged (merge-pathnames "demo-audit-forged.jsonl" cl-user::*here*)))
      (with-open-file (s forged :direction :output :if-exists :supersede :external-format :utf-8)
        (loop for l in lines for i from 1
              do (write-line (if (= i 3) (substitute #\9 #\5 l) l) s)))
      (multiple-value-bind (ok line) (verify-audit forged)
        (format t "Someone edits line 3 (a 5 becomes 9): chain ~:[broken at line ~d~;intact~]~%" ok line))
      (delete-file forged))))
