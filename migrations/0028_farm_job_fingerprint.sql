-- Dấu vân tay của một job farm (plan 2026-10-08 quality-fixes, task 4): sha256 của loại job, requirements, payload
-- (id attempt thay bằng chỗ giữ) và bytes của mọi file job đọc. Attempt sau của cùng stage (worker khởi động lại, mất
-- lease) mà gửi lại đúng job này thì nhận lại job cũ thay vì huỷ rồi gửi lại từ cuối hàng đợi farm. NULL = job ghi
-- trước khi có cột này: không bao giờ được nhận lại, bị huỷ như trước.
ALTER TABLE studio_farm_jobs ADD COLUMN fingerprint TEXT;
