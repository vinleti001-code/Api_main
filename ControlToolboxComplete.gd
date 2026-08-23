extends Control

# Pasang script ini pada node root: Control

@onready var search_input: LineEdit = $PanelContainer/VBoxContainer/HBoxContainer/LineEdit
@onready var get_button: Button = $PanelContainer/VBoxContainer/HBoxContainer/Button
@onready var asset_grid: GridContainer = $PanelContainer/VBoxContainer/ScrollContainer/GridContainer
var thumbnail: TextureRect
var status_asset: Label
@onready var engine: ToolboxEngineManager = $ToolboxEngineManager


func _ready() -> void:
	# Cari node berdasarkan nama di seluruh scene. Ini menghindari error
	# jika TextureRect/StatusAsset tidak berada tepat di bawah VBoxContainer.
	thumbnail = find_child("TextureRect", true, false) as TextureRect
	status_asset = find_child("StatusAsset", true, false) as Label
	if status_asset == null:
		# Fallback jika Label belum diganti namanya menjadi StatusAsset.
		status_asset = find_child("Label", true, false) as Label

	get_button.pressed.connect(_on_search_or_get_pressed)
	search_input.text_submitted.connect(_on_search_text_submitted)

	# Connect signal dari ToolboxEngineManager.
	if engine:
		engine.search_completed.connect(_on_search_completed)
		engine.load_completed.connect(_on_asset_loaded)
		engine.engine_error.connect(_on_engine_error)

		if engine.has_signal("thumbnail_loaded"):
			engine.thumbnail_loaded.connect(_on_thumbnail_loaded)

	if thumbnail:
		thumbnail.texture = null
	if status_asset:
		status_asset.text = "Status asset"


func _on_search_text_submitted(_text: String) -> void:
	_on_search_or_get_pressed()


# ─── 1. ROUTING INPUT USER ───────────────────────────────────────────────────
func _on_search_or_get_pressed() -> void:
	var text := search_input.text.strip_edges()

	if text.is_empty():
		status_asset.text = "Masukkan nama atau ID asset."
		return

	get_button.disabled = true
	thumbnail.texture = null
	status_asset.text = "Memproses..."

	if text.begins_with("https://"):
		engine.load_asset_by_raw_url(text)
	elif text.is_valid_int() and not text.begins_with("-"):
		engine.load_asset_by_id(text)
	else:
		engine.search_assets(text)


# ─── 2. HANDLE PENCARIAN & RENDER LIST ───────────────────────────────────────
func _on_search_completed(items: Array) -> void:
	get_button.disabled = false

	for child in asset_grid.get_children():
		child.queue_free()

	if items.is_empty():
		status_asset.text = "Asset tidak ditemukan."
		return

	status_asset.text = "Ditemukan %d asset." % items.size()

	# Tampilkan thumbnail asset pertama pada TextureRect utama.
	_show_asset_preview(items[0])

	for item in items:
		if not item is Dictionary:
			continue

		var card := Button.new()
		var asset_name := str(item.get("name", "Asset"))
		var asset_id := str(item.get("id", ""))

		card.text = asset_name
		card.tooltip_text = "ID: " + asset_id
		card.custom_minimum_size = Vector2(140, 50)

		# Klik hasil pencarian:
		# 1. Ganti preview thumbnail.
		# 2. Load model berdasarkan ID.
		card.pressed.connect(func() -> void:
			_show_asset_preview(item)

			if not asset_id.is_empty():
				engine.load_asset_by_id(asset_id)
		)

		asset_grid.add_child(card)


func _show_asset_preview(item: Dictionary) -> void:
	var asset_id := str(item.get("id", ""))
	var asset_name := str(item.get("name", "Asset"))

	if asset_id.is_empty():
		status_asset.text = "ID asset tidak valid."
		return

	status_asset.text = asset_name + "\nMemuat thumbnail..."
	thumbnail.texture = null

	if engine.has_method("load_thumbnail"):
		engine.load_thumbnail(item)
	else:
		status_asset.text = "Fungsi load_thumbnail belum tersedia."


func _on_thumbnail_loaded(asset_id: String, texture: Texture2D) -> void:
	thumbnail.texture = texture
	thumbnail.visible = true
	status_asset.text = "Thumbnail berhasil dimuat.\nID: " + asset_id


# ─── 3. HANDLE ASSET LOADED & SPAWN KE DUNIA 3D ──────────────────────────────
func _on_asset_loaded(response_data: Dictionary) -> void:
	get_button.disabled = false
	status_asset.text = "Model berhasil didapatkan dari Vercel."
	print("Model berhasil didapatkan dari Vercel!")

	var model_data: Dictionary = response_data.get("model", {})

	if not model_data.is_empty():
		var current_scene := get_tree().current_scene
		var root_container := Node3D.new()

		# Set nama container model.
		root_container.name = response_data.get("modelName", "RobloxModel")
		current_scene.add_child(root_container)

		# Mulai bangun hierarki 3D.
		_reconstruct_tree(model_data, root_container)

		# Tempatkan model di depan Camera3D aktif.
		var camera := _find_camera(current_scene)
		if camera:
			_fit_model_to_camera(root_container, camera)
		else:
			camera = _create_preview_camera(current_scene)
			_fit_model_to_camera(root_container, camera)

		_ensure_preview_light(current_scene)
		print("Model 3D berhasil di-spawn di dunia!")
		status_asset.text = "Model berhasil di-spawn ke dunia 3D."
	else:
		status_asset.text = "Response berhasil, tetapi data model kosong."


func _find_camera(parent_node: Node) -> Camera3D:
	var camera := parent_node.find_child("Camera3D", true, false) as Camera3D
	if camera:
		return camera

	for child in parent_node.get_children():
		if child is Camera3D:
			return child as Camera3D

	return null


func _create_preview_camera(parent_node: Node) -> Camera3D:
	var camera := Camera3D.new()
	camera.name = "ToolboxPreviewCamera"
	camera.position = Vector3(0, 2, 8)
	parent_node.add_child(camera)
	camera.look_at(Vector3(0, 1, 0), Vector3.UP)
	camera.current = true
	return camera


func _ensure_preview_light(parent_node: Node) -> void:
	var existing_light := parent_node.find_child("DirectionalLight3D", true, false)
	if existing_light:
		return

	var light := DirectionalLight3D.new()
	light.name = "ToolboxPreviewLight"
	light.rotation_degrees = Vector3(-45, -30, 0)
	light.light_energy = 1.5
	parent_node.add_child(light)


func _fit_model_to_camera(model_root: Node3D, camera: Camera3D) -> void:
	# Hitung bounding box semua MeshInstance3D di dalam model.
	var bounds := AABB()
	var has_mesh := false
	var mesh_nodes := model_root.find_children(
		"*",
		"MeshInstance3D",
		true,
		false
	)

	for node in mesh_nodes:
		var mesh_node := node as MeshInstance3D
		if mesh_node == null or mesh_node.mesh == null:
			continue

		var relative_transform := (
			model_root.global_transform.affine_inverse()
			* mesh_node.global_transform
		)
		var mesh_bounds := mesh_node.get_aabb().transformed(relative_transform)

		if not has_mesh:
			bounds = mesh_bounds
			has_mesh = true
		else:
			bounds = bounds.merge(mesh_bounds)

	if not has_mesh or bounds.size.length() <= 0.001:
		model_root.global_position = (
			camera.global_position
			- camera.global_transform.basis.z * 6.0
		)
		return

	# Normalisasi ukuran agar model kecil maupun besar tetap terlihat.
	var largest_dimension := max(
		bounds.size.x,
		max(bounds.size.y, bounds.size.z)
	)
	var scale_factor := clampf(4.0 / largest_dimension, 0.05, 20.0)
	model_root.scale = Vector3.ONE * scale_factor

	var model_center := bounds.position + bounds.size * 0.5
	var view_center := (
		camera.global_position
		- camera.global_transform.basis.z * 6.0
	)

	# Geser root berdasarkan titik tengah model setelah scaling.
	model_root.global_position = view_center - model_center * scale_factor


# ─── 4. LOGIKA RECONSTRUCTOR JSON ROBLOX KE NODE3D ───────────────────────────
func _reconstruct_tree(data: Dictionary, parent_node: Node) -> void:
	if data.is_empty():
		return

	var class_name_str := str(data.get("className", "Folder"))
	var properties: Dictionary = data.get("properties", {})
	var children: Array = data.get("children", [])

	var current_node: Node

	# Konversi Part/Mesh Roblox ke MeshInstance3D Godot.
	match class_name_str:
		"Part", "WedgePart", "CornerWedgePart", "MeshPart", "UnionOperation", "BasePart":
			var mesh_inst := MeshInstance3D.new()
			var box := BoxMesh.new()

			# Set ukuran Part.
			if properties.has("Size") and properties["Size"].get("t") == "Vector3":
				var size_value = properties["Size"].get("v", [])
				if size_value is Array and size_value.size() >= 3:
					box.size = Vector3(
						float(size_value[0]),
						float(size_value[1]),
						float(size_value[2])
					)

			mesh_inst.mesh = box

			# Set warna Part.
			if properties.has("Color3") and properties["Color3"].get("t") == "Color3":
				var color_value = properties["Color3"].get("v", [])
				if color_value is Array and color_value.size() >= 3:
					var material := StandardMaterial3D.new()
					material.albedo_color = Color(
						float(color_value[0]) / 255.0,
						float(color_value[1]) / 255.0,
						float(color_value[2]) / 255.0
					)
					mesh_inst.material_override = material

			current_node = mesh_inst

		_:
			current_node = Node3D.new()

	# Set nama node dari property Roblox.
	if properties.has("Name") and properties["Name"].get("t") == "string":
		current_node.name = str(properties["Name"].get("v", "Node"))

	# Set posisi CFrame.
	if current_node is Node3D:
		if properties.has("CFrame") and properties["CFrame"].get("t") == "CFrame":
			var cframe_value = properties["CFrame"].get("v", [])
			if cframe_value is Array and cframe_value.size() >= 3:
				current_node.position = Vector3(
					float(cframe_value[0]),
					float(cframe_value[1]),
					float(cframe_value[2])
				)

	parent_node.add_child(current_node)

	# Proses rekursif untuk semua anak.
	for child_data in children:
		if child_data is Dictionary:
			_reconstruct_tree(child_data, current_node)


func _on_engine_error(msg: String) -> void:
	get_button.disabled = false
	status_asset.text = msg
	print("ERR: ", msg)