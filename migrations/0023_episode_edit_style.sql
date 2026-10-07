-- Kiểu dựng của từng tập (plan pha 5 nhóm C3, ADR-0001 mục 152): `whole` ghép nguyên video (timeline v3,
-- ag-studio-episode@1.3.0), `cut` cắt theo shot (timeline v4, ag-studio-episode-cut@1.0.0). Plan 3.1.0 trở đi ghi
-- theo kế hoạch tập; mọi tập có trước là `whole`.
ALTER TABLE episodes ADD COLUMN edit_style TEXT NOT NULL DEFAULT 'whole' CHECK (edit_style IN ('whole', 'cut'));
