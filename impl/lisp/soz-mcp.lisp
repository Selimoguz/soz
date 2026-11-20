;;;; soz-mcp.lisp — Runs the soz MCP gateway over stdio.
;;;; sbcl --script impl/lisp/soz-mcp.lisp path/to/gateway.json
;;;; Standard output carries only MCP messages; everything else goes to standard error.

(setf sb-impl::*default-external-format* :utf-8)
(let ((*standard-output* *error-output*))
  (dolist (f '("json" "soz" "run" "ed25519" "gateway"))
    (load (merge-pathnames (format nil "~a.lisp" f) *load-truename*))))

(let ((config (second sb-ext:*posix-argv*)))
  (unless config
    (format *error-output* "usage: soz-mcp gateway.json~%")
    (sb-ext:exit :code 2))
  (handler-case (soz-gateway:main config)
    (sb-sys:interactive-interrupt () (sb-ext:exit :code 0)))
  (sb-ext:exit :code 0))
