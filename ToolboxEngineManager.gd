extends Node
class_name ToolboxEngineManager

signal search_completed(result_items: Array)
signal load_completed(model_data: Dictionary)
signal engine_error(error_msg: String)
signal thumbnail_loaded(asset_id: String, texture: Texture2D)

const ENGINE_SEARCH_URL := "https://api-main-black.vercel.app/api/engine/search"
const ENGINE_LOAD_URL := "https://api-main-black.vercel.app/api/engine/load"
const ENGINE_RAW_URL := "https://api-main-black.vercel.app/api/engine/load-url"

enum RequestType { SEARCH, LOAD_ID, LOAD_RAW }


# Godot bukan browser. Origin, Referer, Sec-Fetch-* dan User-Agent Chrome
# tidak diperlukan dan tidak dapat melewati Vercel Deployment Protection.
func _get_json_headers() -> PackedStringArray:
	return PackedStringArray([
		"Accept: application/json",
		"Content-Type: application/json"
	])


func search_assets(
		keyword: String,
		limit: int = 10,
		asset_type: String = "Model",
		sort: String = "Relevance",
		cursor: String = ""
	) -> void:
	var clean_keyword := keyword.strip_edges()
	if clean_keyword.is_empty():
		engine_error.emit("Keyword tidak boleh kosong.")
		return

	var query := "q=%s&limit=%d&sort=%s&assetType=%s" % [
		clean_keyword.uri_encode(),
		clampi(limit, 1, 28),
		sort.uri_encode(),
		asset_type.uri_encode()
	]
	if not cursor.is_empty():
		query += "&cursor=%s" % cursor.uri_encode()

	var url := "%s?%s" % [ENGINE_SEARCH_URL, query]
	_create_and_send_request(
		url,
		PackedStringArray(["Accept: application/json"]),
		HTTPClient.METHOD_GET,
		"",
		RequestType.SEARCH
	)


func load_asset_by_id(asset_id: String) -> void:
	var clean_id := asset_id.strip_edges()
	# Godot tidak menyediakan String.matches_regex(). is_valid_int()
	# tersedia di Godot 4, lalu tanda minus ditolak karena asset ID Roblox
	# harus berupa angka positif.
	if clean_id.is_empty() or not clean_id.is_valid_int() or clean_id.begins_with("-"):
		engine_error.emit("Asset ID harus berupa angka positif.")
		return

	var payload := JSON.stringify({
		"assetId": clean_id,
		"includeScripts": false
	})
	_create_and_send_request(
		ENGINE_LOAD_URL,
		_get_json_headers(),
		HTTPClient.METHOD_POST,
		payload,
		RequestType.LOAD_ID
	)


func load_asset_by_raw_url(raw_url: String, model_name: String = "") -> void:
	var clean_url := raw_url.strip_edges()
	if not clean_url.begins_with("https://"):
		engine_error.emit("URL harus menggunakan HTTPS.")
		return

	var payload: Dictionary = {"rawUrl": clean_url}
	if not model_name.strip_edges().is_empty():
		payload["modelName"] = model_name.strip_edges()

	_create_and_send_request(
		ENGINE_RAW_URL,
		_get_json_headers(),
		HTTPClient.METHOD_POST,
		JSON.stringify(payload),
		RequestType.LOAD_RAW
	)


func load_thumbnail(asset: Dictionary) -> void:
	var asset_id := str(asset.get("id", ""))
	var thumbnail_url := str(asset.get("thumbnail", ""))
	if asset_id.is_empty() or thumbnail_url.is_empty():
		engine_error.emit("Thumbnail asset %s tidak tersedia." % asset_id)
		return

	var http_req := HTTPRequest.new()
	add_child(http_req)
	http_req.request_completed.connect(
		func(
			result: int,
			response_code: int,
			_headers: PackedStringArray,
			body: PackedByteArray
		) -> void:
			if result != HTTPRequest.RESULT_SUCCESS or response_code != 200:
				engine_error.emit(
					"Thumbnail asset %s gagal dimuat (HTTP %d)." %
					[asset_id, response_code]
				)
				http_req.queue_free()
				return

			var image := Image.new()
			if image.load_png_from_buffer(body) != OK:
				engine_error.emit("Format thumbnail asset %s tidak valid." % asset_id)
				http_req.queue_free()
				return

			thumbnail_loaded.emit(asset_id, ImageTexture.create_from_image(image))
			http_req.queue_free()
	)

	var request_error := http_req.request(
		thumbnail_url,
		PackedStringArray(["Accept: image/png"]),
		HTTPClient.METHOD_GET
	)
	if request_error != OK:
		http_req.queue_free()
		engine_error.emit(
			"Gagal meminta thumbnail asset %s: %s" %
			[asset_id, error_string(request_error)]
		)


func _create_and_send_request(
		url: String,
		headers: PackedStringArray,
		method: HTTPClient.Method,
		payload: String,
		request_type: RequestType
	) -> void:
	var http_req := HTTPRequest.new()
	add_child(http_req)

	# Jangan memakai TLSOptions.client_unsafe() untuk production.
	# Sertifikat HTTPS Vercel valid dan seharusnya diverifikasi Godot.
	var callback := func(
			result: int,
			response_code: int,
			response_headers: PackedStringArray,
			body: PackedByteArray
		) -> void:
		_on_request_completed(
			result,
			response_code,
			response_headers,
			body,
			request_type
		)
		http_req.queue_free()

	http_req.request_completed.connect(callback)
	var request_error := http_req.request(url, headers, method, payload)
	if request_error != OK:
		http_req.queue_free()
		engine_error.emit(
			"Godot gagal mengirim request: %s" % error_string(request_error)
		)


func _on_request_completed(
		result: int,
		response_code: int,
		_headers: PackedStringArray,
		body: PackedByteArray,
		request_type: RequestType
	) -> void:
	if result != HTTPRequest.RESULT_SUCCESS:
		engine_error.emit(
			"Koneksi ke Toolbox gagal: %s" % _http_result_text(result)
		)
		return

	var response_text := body.get_string_from_utf8()
	var json := JSON.new()
	var parse_error := json.parse(response_text)
	if parse_error != OK:
		engine_error.emit(
			"Server mengembalikan response bukan JSON (HTTP %d)." % response_code
		)
		return

	var data = json.data
	if response_code < 200 or response_code >= 300:
		var server_error := "HTTP Error %d" % response_code
		if data is Dictionary and data.has("error"):
			server_error = str(data["error"])
		engine_error.emit(server_error)
		return

	if not data is Dictionary:
		engine_error.emit("Format response server tidak valid.")
		return

	if data.has("error"):
		engine_error.emit(str(data["error"]))
		return

	match request_type:
		RequestType.SEARCH:
			# Endpoint API mengembalikan { keyword, assets, nextCursor, ... }.
			var items = data.get("assets", [])
			if items is Array:
				search_completed.emit(items)
			else:
				engine_error.emit("Format data pencarian tidak valid.")

		RequestType.LOAD_ID, RequestType.LOAD_RAW:
			if data.has("model") and data["model"] is Dictionary:
				load_completed.emit(data)
			else:
				engine_error.emit("Engine tidak mengembalikan struktur model.")


func _http_result_text(result: int) -> String:
	match result:
		HTTPRequest.RESULT_CANT_CONNECT:
			return "tidak dapat terhubung ke server"
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "domain tidak dapat ditemukan"
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "koneksi terputus"
		HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
			return "TLS/HTTPS gagal"
		HTTPRequest.RESULT_TIMEOUT:
			return "request timeout"
		_:
			return "kode error %d" % result