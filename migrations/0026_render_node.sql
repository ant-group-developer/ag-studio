-- Ghim bản render cuối vào một máy farm cụ thể (deferred-items, sau pha 3): cùng dòng lựa chọn kiểu máy, thêm id và tên
-- máy (tên để hiện; máy có thể đổi tên hoặc bị gỡ sau đó). Worker gửi `requirements.node_id`; hub chỉ giao job cho máy
-- đó (ag-farm `nodeMeetsRequirements`). NULL = không ghim.
ALTER TABLE studio_render_choices ADD COLUMN node_id TEXT;
ALTER TABLE studio_render_choices ADD COLUMN node_name TEXT;
