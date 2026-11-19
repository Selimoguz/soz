;;;; common.lisp — Shared helpers for the example demos (examples/*/demo.lisp).

(setf sb-impl::*default-external-format* :utf-8)
(let ((*standard-output* *error-output*))
  (dolist (f '("json" "soz" "run"))
    (load (merge-pathnames (format nil "../impl/lisp/~a.lisp" f) *load-truename*))))

(defpackage :soz-example
  (:use :cl :soz)
  (:export #:*dir* #:setup #:file-text #:banner #:replace-all #:show-check #:show-preview #:approve
           #:*journal* #:*audit*))

(in-package :soz-example)

(defvar *dir* nil "The example's folder.")
(defvar *journal* nil)
(defvar *audit* nil)

(defun file-text (name)
  (with-open-file (s (merge-pathnames name *dir*) :external-format :utf-8)
    (let ((text (make-string (file-length s)))) (subseq text 0 (read-sequence text s)))))

(defun replace-all (text old new)
  (with-output-to-string (o)
    (loop with start = 0
          for i = (search old text :start2 start)
          do (write-string text o :start start :end (or i (length text)))
             (if i (progn (write-string new o) (setf start (+ i (length old)))) (return)))))

(defun setup (dir)
  "Loads DIR/operations.json and starts a fresh journal and audit record in DIR. Returns the message."
  (setf *dir* dir
        *operations* (make-hash-table :test #'equal))
  (map nil #'operation-from-json (json:json-oku (file-text "operations.json")))
  (dolist (f '("demo-journal.jsonl" "demo-audit.jsonl"))
    (let ((p (merge-pathnames f dir))) (when (probe-file p) (delete-file p))))
  (setf *journal* (open-journal (merge-pathnames "demo-journal.jsonl" dir))
        *audit* (open-audit (merge-pathnames "demo-audit.jsonl" dir)))
  ;; An optional policy.json: {"actor": {...}, "rules": [...]} (SPEC 12).
  (let ((pol (merge-pathnames "policy.json" dir)))
    (if (probe-file pol)
        (let ((j (json:json-oku (file-text "policy.json"))))
          (setf *policy* (policy-from-json j) *actor* (actor-from-json (gethash "actor" j))))
        (setf *policy* '() *actor* nil)))
  (string-trim '(#\Newline #\Return #\Space) (file-text "message.txt")))

(defun banner (text) (format t "~%=== ~a ===~%" text))

(defun show-check (plan message)
  "Checks PLAN and prints the summary or the errors, as the model would get them."
  (let ((r (check-plan plan :message message)))
    (format t "~a~%" (if (result-valid r) (plan-summary r) (error-report r)))
    r))

(defun show-preview (plan message)
  (let ((p (preview plan :message message :journal *journal* :audit *audit*)))
    (format t "~a" (preview-summary p))
    p))

(defun approve (p &key approvers)
  "APPROVERS (by default the person who asked) approve the preview; prints what happened."
  (when approvers (format t "Approved by: ~{~a~^, ~}~%" (mapcar #'actor-id approvers)))
  (let ((e (execute p (preview-hash p) :journal *journal* :audit *audit* :approved-by "demo user"
                                       :approvers approvers)))
    (format t "Outcome: ~a~@[ (~a)~]~@[~%The plan stopped: ~a~]~%Steps: ~{~a~^, ~}~%"
            (execution-outcome e) (execution-message e) (execution-stop-reason e)
            (mapcar (lambda (s) (format nil "~d ~a" (step-index s) (step-status s))) (execution-steps e)))
    e))
