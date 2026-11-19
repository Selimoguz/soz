;;;; demo.lisp — Paying a supplier invoice through a bank API that does whatever it is told.
;;;; sbcl --script examples/payments/demo.lisp

(load (merge-pathnames "../common.lisp" *load-truename*))
(in-package :soz-example)

(defvar *here* (make-pathname :name nil :type nil :defaults *load-truename*))

;;; The pretend bank. Its pay call has no duplicate check of its own, like many real ones.
(defvar *invoices* (list (list "INV-2026-118" "Akdeniz Gida" 1245075/100 "TRY" "TR33 0006 1005 1978 6457 8413 26" "open")
                         (list "INV-2026-120" "Akdeniz Gida" 3200 "TRY" "TR33 0006 1005 1978 6457 8413 26" "open")
                         (list "INV-2026-090" "Akdeniz Gida" 980 "TRY" "TR33 0006 1005 1978 6457 8413 26" "paid")))
(defvar *available* 50000)
(defvar *transfers* '())

(define-implementation bank.find_invoice (args)
  (let ((i (find (gethash "number" args) *invoices* :key #'first :test #'string=)))
    (unless i (error 'operation-failed :message "no such invoice"))
    (destructuring-bind (number supplier amount currency iban status) i
      (json:json-nesne "number" number "supplier" supplier "amount" amount "currency" currency "iban" iban
                       "status" status))))

(define-implementation bank.balance (args)
  (declare (ignore args))
  (json:json-nesne "available" *available* "currency" "TRY"))

(define-implementation bank.pay (args)
  (decf *available* (gethash "amount" args))
  (push (list (gethash "reference" args) (gethash "amount" args) (gethash "to_iban" args)) *transfers*)
  (json:json-nesne "transfer" (format nil "TX-~d" (length *transfers*))))

(defun transfers () (format nil "~d transfer(s)~{; ~a~}" (length *transfers*)
                            (mapcar (lambda (x) (format nil "~a ~a TRY" (first x) (soz::number-text (second x))))
                                    (reverse *transfers*))))

(let ((message (setup *here*)))
  (format t "Message: ~a~%From: ~a (~{~a~^, ~})~%Policy: ~{~a~^; ~}~%" message (actor-id *actor*) (actor-roles *actor*)
          (mapcar #'soz::rule-name *policy*))

  (banner "1. The model pays from memory: a rounded amount and an IBAN nobody gave it")
  (show-check (file-text "invented.soz") message)

  (banner "2. The model looks the invoice up instead: preview (reads run, nothing is paid)")
  (let ((p (show-preview (file-text "good.soz") message)))
    (format t "Bank: ~a~%" (transfers))

    (banner "3. Approval: the policy asks for someone in finance besides Ali")
    (approve p)
    (format t "Bank: ~a~%" (transfers))
    (approve p :approvers (list *actor* (make-actor :id "ayse" :roles '("finance"))))
    (format t "Bank: ~a~%" (transfers)))

  (banner "4. The same request arrives again (a forwarded e-mail, a retry)")
  (let ((p (show-preview (file-text "good.soz") message)))
    (approve p)
    (format t "Bank: ~a  <- the bank would have paid again; the key (the invoice number) did not~%" (transfers)))

  (banner "5. Another invoice; the supplier corrects it after the preview, before the approval")
  (let* ((message2 "Please pay invoice INV-2026-120 from Akdeniz Gida, 3.200 TRY.")
         (plan2 (replace-all (replace-all (file-text "good.soz") "INV-2026-118" "INV-2026-120")
                             "12450.75" "3200"))
         (plan2 (replace-all plan2 "12.450,75" "3.200"))
         (p (show-preview plan2 message2)))
    (setf (third (second *invoices*)) 3400)
    (format t "(The supplier changes the invoice to 3.400 TRY.)~%")
    (approve p)
    (format t "Bank: ~a~%" (transfers)))

  (banner "6. An invoice the bank already shows as paid")
  (format t "(The plan compares the invoice's status with \"paid\", a value the bank's API declares.)~%")
  (show-preview (replace-all (replace-all (replace-all (file-text "good.soz") "INV-2026-118" "INV-2026-090")
                                          "12450.75" "980") "12.450,75" "980")
                "Please pay invoice INV-2026-090 from Akdeniz Gida, 980 TRY.")
  (format t "Bank: ~a~%" (transfers))

  (banner "7. The audit record")
  (format t "~d lines, chain ~:[BROKEN~;intact~]~%" (length (audit-lines *audit*))
          (verify-audit (merge-pathnames "demo-audit.jsonl" *here*))))
