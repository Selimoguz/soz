;;;; soz-check.lisp — Command line checker.
;;;; sbcl --script impl/lisp/soz-check.lisp OPERATIONS.json PLAN.soz [--message TEXT | --message-file FILE] [--json]
;;;; Exit code: 0 valid, 1 invalid, 2 usage error.

(setf sb-impl::*default-external-format* :utf-8)
(load (merge-pathnames "json.lisp" *load-truename*))
(load (merge-pathnames "soz.lisp" *load-truename*))

(defpackage :soz-check (:use :cl :soz))
(in-package :soz-check)

(defun read-file (path)
  (with-open-file (s path :external-format :utf-8)
    (let ((text (make-string (file-length s))))
      (subseq text 0 (read-sequence text s)))))

(defun usage ()
  (format *error-output* "usage: soz-check OPERATIONS.json PLAN.soz [--message TEXT | --message-file FILE] [--json]~%")
  (sb-ext:exit :code 2))

(let ((args (rest sb-ext:*posix-argv*)) (files '()) (message nil) (json nil))
  (loop while args
        do (let ((a (pop args)))
             (cond ((string= a "--message") (setf message (or (pop args) (usage))))
                   ((string= a "--message-file") (setf message (read-file (or (pop args) (usage)))))
                   ((string= a "--json") (setf json t))
                   (t (push a files)))))
  (setf files (nreverse files))
  (unless (= (length files) 2) (usage))
  (setf *operations* (make-hash-table :test #'equal))
  (map nil #'operation-from-json (json:json-oku (read-file (first files))))
  (let ((r (check-plan (read-file (second files)) :message message)))
    (if json
        (progn (write-string (json:json-yaz (result-json r))) (terpri))
        (format t "~a~%" (if (result-valid r) (plan-summary r) (error-report r))))
    (sb-ext:exit :code (if (result-valid r) 0 1))))
