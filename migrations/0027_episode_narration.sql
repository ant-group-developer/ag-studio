-- Bỏ lời dẫn cho riêng một tập (plan optional-audio, Q1): `none` = tập này dựng không lời dẫn dù production có giọng
-- (hoặc chưa có); NULL = theo production. Chỉ tập cắt theo shot có lời dẫn.
ALTER TABLE episodes ADD COLUMN narration_override TEXT CHECK (narration_override IN ('none'));
