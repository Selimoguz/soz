;;;; demo.lisp — Restarting servers through an infrastructure API that does whatever it is told.
;;;; sbcl --script examples/devops/demo.lisp

(load (merge-pathnames "../common.lisp" *load-truename*))
(in-package :soz-example)

(defvar *here* (make-pathname :name nil :type nil :defaults *load-truename*))

;;; The pretend infrastructure: (name env healthy). A restart is recorded; it does not fix the
;;; health check (the fault is elsewhere), so the servers stay unhealthy.
(defvar *servers* (list (list "web-1" "staging" t) (list "web-2" "staging" nil)
                        (list "web-3" "staging" nil) (list "web-4" "staging" t)
                        (list "web-1" "production" nil) (list "web-2" "production" t)))
(defvar *restarts* '())

(define-implementation infra.list_servers (args)
  (coerce (loop for (name env healthy) in *servers*
                when (string= env (gethash "env" args))
                  collect (json:json-nesne "name" name "env" env "version" "2.4.1" "healthy" (if healthy :true :false)))
          'vector))

(define-implementation infra.restart (args)
  (push (format nil "~a/~a (~a)" (gethash "env" args) (gethash "server" args) (gethash "ticket" args)) *restarts*)
  (json:json-nesne "restarted" (gethash "server" args)))

(defun restarts () (format nil "~d restart(s)~{; ~a~}" (length *restarts*) (reverse *restarts*)))

(let ((message (setup *here*)))
  (format t "Message: ~a~%" message)

  (banner "1. The model looks in production instead of staging")
  (show-check (file-text "invented.soz") message)
  (format t "(Looking servers up in production is allowed; restarting what that lookup found is not.)~%")

  (banner "2. Staging, as asked: preview (the list is read, nothing is restarted)")
  (let ((p (show-preview (file-text "good.soz") message)))
    (format t "Infrastructure: ~a~%" (restarts))

    (banner "3. The person approves")
    (approve p)
    (format t "Infrastructure: ~a~%" (restarts)))

  (banner "4. The same ticket runs again; the servers are still unhealthy")
  (approve (show-preview (file-text "good.soz") message))
  (format t "Infrastructure: ~a  <- a restart is once per server per ticket; a new ticket restarts again~%" (restarts))

  (banner "5. A new ticket; web-4 fails too, after the preview and before the approval")
  (let* ((message2 "OPS-513: restart the unhealthy web servers in staging.")
         (p (show-preview (replace-all (file-text "good.soz") "OPS-512" "OPS-513") message2)))
    (setf (third (fourth *servers*)) nil)
    (format t "(web-4's health check starts failing.)~%")
    (approve p)
    (format t "Infrastructure: ~a  <- web-4 was not in what the person approved~%" (restarts)))

  (banner "6. The audit record")
  (format t "~d lines, chain ~:[BROKEN~;intact~]~%" (length (audit-lines *audit*))
          (verify-audit (merge-pathnames "demo-audit.jsonl" *here*))))
