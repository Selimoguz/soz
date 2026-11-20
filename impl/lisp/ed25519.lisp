;;;; ed25519.lisp — SHA-512 and Ed25519 signature verification (RFC 6234, RFC 8032), without
;;;; dependencies, for the gateway to check another person's signed approval (SPEC 11.6).
;;;; Only verification: signing happens on the approver's own machine (soz-approve).

(defpackage :soz-ed25519
  (:use :cl)
  (:export #:sha512 #:ed25519-verify #:base64url-decode))

(in-package :soz-ed25519)

;;; --- SHA-512 ---------------------------------------------------------------------------------------

(defparameter +k512+
  (map 'vector (lambda (s) (parse-integer s :radix 16))
       '("428a2f98d728ae22" "7137449123ef65cd" "b5c0fbcfec4d3b2f" "e9b5dba58189dbbc" "3956c25bf348b538" "59f111f1b605d019"
         "923f82a4af194f9b" "ab1c5ed5da6d8118" "d807aa98a3030242" "12835b0145706fbe" "243185be4ee4b28c" "550c7dc3d5ffb4e2"
         "72be5d74f27b896f" "80deb1fe3b1696b1" "9bdc06a725c71235" "c19bf174cf692694" "e49b69c19ef14ad2" "efbe4786384f25e3"
         "0fc19dc68b8cd5b5" "240ca1cc77ac9c65" "2de92c6f592b0275" "4a7484aa6ea6e483" "5cb0a9dcbd41fbd4" "76f988da831153b5"
         "983e5152ee66dfab" "a831c66d2db43210" "b00327c898fb213f" "bf597fc7beef0ee4" "c6e00bf33da88fc2" "d5a79147930aa725"
         "06ca6351e003826f" "142929670a0e6e70" "27b70a8546d22ffc" "2e1b21385c26c926" "4d2c6dfc5ac42aed" "53380d139d95b3df"
         "650a73548baf63de" "766a0abb3c77b2a8" "81c2c92e47edaee6" "92722c851482353b" "a2bfe8a14cf10364" "a81a664bbc423001"
         "c24b8b70d0f89791" "c76c51a30654be30" "d192e819d6ef5218" "d69906245565a910" "f40e35855771202a" "106aa07032bbd1b8"
         "19a4c116b8d2d0c8" "1e376c085141ab53" "2748774cdf8eeb99" "34b0bcb5e19b48a8" "391c0cb3c5c95a63" "4ed8aa4ae3418acb"
         "5b9cca4f7763e373" "682e6ff3d6b2b8a3" "748f82ee5defb2fc" "78a5636f43172f60" "84c87814a1f0ab72" "8cc702081a6439ec"
         "90befffa23631e28" "a4506cebde82bde9" "bef9a3f7b2c67915" "c67178f2e372532b" "ca273eceea26619c" "d186b8c721c0c207"
         "eada7dd6cde0eb1e" "f57d4f7fee6ed178" "06f067aa72176fba" "0a637dc5a2c898a6" "113f9804bef90dae" "1b710b35131c471b"
         "28db77f523047d84" "32caab7b40c72493" "3c9ebe0a15c9bebc" "431d67c49c100d4c" "4cc5d4becb3e42b6" "597f299cfc657e2a"
         "5fcb6fab3ad6faec" "6c44198c4a475817")))

(defun sha512 (bytes)
  "SHA-512 of a vector of octets, as a vector of 64 octets."
  (let* ((len (length bytes))
         (total (* 128 (ceiling (+ len 17) 128)))
         (m (make-array total :element-type '(unsigned-byte 8) :initial-element 0))
         (h (map 'vector (lambda (s) (parse-integer s :radix 16))
                 '("6a09e667f3bcc908" "bb67ae8584caa73b" "3c6ef372fe94f82b" "a54ff53a5f1d36f1"
                   "510e527fade682d1" "9b05688c2b3e6c1f" "1f83d9abfb41bd6b" "5be0cd19137e2179")))
         (w (make-array 80))
         (mask #xffffffffffffffff))
    (replace m bytes)
    (setf (aref m len) #x80)
    (loop for i from 0 below 16
          do (setf (aref m (- total 1 i)) (ldb (byte 8 (* 8 i)) (* 8 len))))
    (flet ((rotr (x n) (logand mask (logior (ash x (- n)) (ash x (- 64 n)))))
           (add (&rest xs) (logand mask (apply #'+ xs))))
      (loop for chunk from 0 below total by 128 do
        (loop for i from 0 below 16
              do (setf (aref w i) (loop for j from 0 below 8
                                        sum (ash (aref m (+ chunk (* 8 i) j)) (* 8 (- 7 j))))))
        (loop for i from 16 below 80
              do (let* ((a (aref w (- i 15))) (b (aref w (- i 2)))
                        (s0 (logxor (rotr a 1) (rotr a 8) (ash a -7)))
                        (s1 (logxor (rotr b 19) (rotr b 61) (ash b -6))))
                   (setf (aref w i) (add (aref w (- i 16)) s0 (aref w (- i 7)) s1))))
        (let ((a (aref h 0)) (b (aref h 1)) (c (aref h 2)) (d (aref h 3))
              (e (aref h 4)) (f (aref h 5)) (g (aref h 6)) (hh (aref h 7)))
          (loop for i from 0 below 80
                do (let* ((s1 (logxor (rotr e 14) (rotr e 18) (rotr e 41)))
                          (ch (logxor (logand e f) (logand (logxor e mask) g)))
                          (t1 (add hh s1 ch (aref +k512+ i) (aref w i)))
                          (s0 (logxor (rotr a 28) (rotr a 34) (rotr a 39)))
                          (maj (logxor (logand a b) (logand a c) (logand b c)))
                          (t2 (add s0 maj)))
                     (setf hh g g f f e e (add d t1) d c c b b a a (add t1 t2))))
          (loop for i from 0 for x in (list a b c d e f g hh)
                do (setf (aref h i) (add (aref h i) x))))))
    (let ((out (make-array 64 :element-type '(unsigned-byte 8))))
      (loop for i from 0 below 8
            do (loop for j from 0 below 8
                     do (setf (aref out (+ (* 8 i) j)) (ldb (byte 8 (* 8 (- 7 j))) (aref h i)))))
      out)))

;;; --- Ed25519 verification -------------------------------------------------------------------------

(defconstant +p+ (- (expt 2 255) 19))
(defconstant +l+ (+ (expt 2 252) 27742317777372353535851937790883648493))
(defun inv (x) (mod-expt x (- +p+ 2) +p+))
(defun mod-expt (b e m)
  (let ((r 1) (b (mod b m)))
    (loop while (plusp e)
          do (when (oddp e) (setf r (mod (* r b) m)))
             (setf b (mod (* b b) m) e (ash e -1)))
    r))
(defparameter +d+ (mod (* -121665 (inv 121666)) +p+))
(defparameter +sqrt-1+ (mod-expt 2 (/ (- +p+ 1) 4) +p+))

;; Points in extended coordinates (X Y Z T), x = X/Z, y = Y/Z, x*y = T/Z.
(defun point-add (p q)
  (destructuring-bind (x1 y1 z1 t1) p
    (destructuring-bind (x2 y2 z2 t2) q
      (let* ((a (mod (* (- y1 x1) (- y2 x2)) +p+))
             (b (mod (* (+ y1 x1) (+ y2 x2)) +p+))
             (c (mod (* 2 t1 t2 +d+) +p+))
             (d (mod (* 2 z1 z2) +p+))
             (e (- b a)) (f (- d c)) (g (+ d c)) (h (+ b a)))
        (list (mod (* e f) +p+) (mod (* g h) +p+) (mod (* f g) +p+) (mod (* e h) +p+))))))

(defun scalar-mult (k p)
  (let ((r (list 0 1 1 0)))
    (loop for i from (1- (integer-length k)) downto 0
          do (setf r (point-add r r))
             (when (logbitp i k) (setf r (point-add r p))))
    r))

(defun le-int (bytes &key (start 0) (end (length bytes)))
  (loop for i from start below end sum (ash (aref bytes i) (* 8 (- i start)))))

(defun decode-point (bytes)
  "The point a 32-octet encoding names, or NIL if it names none."
  (let* ((n (le-int bytes)) (y (ldb (byte 255 0) n)) (sign (ldb (byte 1 255) n)))
    (when (>= y +p+) (return-from decode-point nil))
    (let* ((u (mod (- (* y y) 1) +p+)) (v (mod (+ (* +d+ y y) 1) +p+))
           (x2 (mod (* u (inv v)) +p+))
           (x (mod-expt x2 (/ (+ +p+ 3) 8) +p+)))
      (unless (= (mod (* x x) +p+) x2) (setf x (mod (* x +sqrt-1+) +p+)))
      (unless (= (mod (* x x) +p+) x2) (return-from decode-point nil))
      (when (and (zerop x) (= sign 1)) (return-from decode-point nil))
      (unless (= (logand x 1) sign) (setf x (- +p+ x)))
      (list x y 1 (mod (* x y) +p+)))))

(defun encode-point (p)
  (destructuring-bind (x y z tt) p
    (declare (ignore tt))
    (let* ((zi (inv z)) (x (mod (* x zi) +p+)) (y (mod (* y zi) +p+))
           (n (logior y (ash (logand x 1) 255)))
           (out (make-array 32 :element-type '(unsigned-byte 8))))
      (loop for i from 0 below 32 do (setf (aref out i) (ldb (byte 8 (* 8 i)) n)))
      out)))

(defparameter +base+
  (let ((y (mod (* 4 (inv 5)) +p+)))
    (decode-point (let ((out (make-array 32 :element-type '(unsigned-byte 8))))
                    (loop for i from 0 below 32 do (setf (aref out i) (ldb (byte 8 (* 8 i)) y)))
                    out))))

(defun ed25519-verify (public-key message signature)
  "True if SIGNATURE (64 octets) is PUBLIC-KEY's (32 octets) signature of MESSAGE (octets), RFC 8032 5.1.7."
  (and (= (length public-key) 32) (= (length signature) 64)
       (let ((a (decode-point public-key))
             (s (le-int signature :start 32 :end 64)))
         (and a (< s +l+)
              (decode-point (subseq signature 0 32))
              (let* ((k (mod (le-int (sha512 (concatenate '(vector (unsigned-byte 8))
                                                          (subseq signature 0 32) public-key message)))
                             +l+))
                     ;; [S]B - [k]A, encoded, must be R
                     (sb (scalar-mult s +base+))
                     (ka (scalar-mult k a))
                     (neg-ka (destructuring-bind (x y z tt) ka (list (mod (- x) +p+) y z (mod (- tt) +p+)))))
                (equalp (encode-point (point-add sb neg-ka)) (subseq signature 0 32)))))))

;;; --- base64url ------------------------------------------------------------------------------------

(defun base64url-decode (s)
  "The octets of an unpadded base64url text, or NIL if it is not one."
  (let ((alphabet "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        (bits 0) (n 0) (out '()))
    (loop for c across s
          for v = (position c alphabet)
          do (unless v (return-from base64url-decode nil))
             (setf bits (logior (ash bits 6) v) n (+ n 6))
             (when (>= n 8)
               (decf n 8)
               (push (ldb (byte 8 n) bits) out)
               (setf bits (ldb (byte n 0) bits))))
    (unless (zerop bits) (return-from base64url-decode nil))   ; leftover bits must be zero
    (coerce (nreverse out) '(vector (unsigned-byte 8)))))
