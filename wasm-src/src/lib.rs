//! Noteva IP Location WASM Plugin
//!
//! Hooks:
//! - comment_after_create: Fetch IP geolocation, store as article-level JSON map
//! - handle_request: API endpoint for frontend to fetch location data
//!
//! Storage format: article_locs:{article_id} = {"comment_id":"location",...}

use std::alloc::{alloc, Layout};
use std::slice;

// ============================================================
// Host function declarations
// ============================================================

extern "C" {
    fn host_http_request(
        method_ptr: i32, method_len: i32,
        url_ptr: i32, url_len: i32,
        headers_ptr: i32, headers_len: i32,
        body_ptr: i32, body_len: i32,
    ) -> i32;

    fn host_storage_get(key_ptr: i32, key_len: i32) -> i32;

    fn host_storage_set(
        key_ptr: i32, key_len: i32,
        value_ptr: i32, value_len: i32,
    ) -> i32;

    fn host_log(
        level_ptr: i32, level_len: i32,
        msg_ptr: i32, msg_len: i32,
    );
}

// ============================================================
// Memory allocator (required by host)
// ============================================================

#[no_mangle]
pub extern "C" fn allocate(size: i32) -> i32 {
    if size <= 0 || size > 4 * 1024 * 1024 { return 0; }
    let layout = match Layout::from_size_align(size as usize, 1) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    let ptr = unsafe { alloc(layout) };
    if ptr.is_null() { 0 } else { ptr as i32 }
}

// ============================================================
// Host function wrappers
// ============================================================

fn log(level: &str, msg: &str) {
    unsafe {
        host_log(
            level.as_ptr() as i32, level.len() as i32,
            msg.as_ptr() as i32, msg.len() as i32,
        );
    }
}

fn storage_get(key: &str) -> Option<String> {
    let result_ptr = unsafe {
        host_storage_get(key.as_ptr() as i32, key.len() as i32)
    };
    if result_ptr <= 0 { return None; }
    let json = read_result(result_ptr)?;
    if !json.contains("\"found\":true") { return None; }
    extract_json_string(&json, "value")
}

fn storage_set(key: &str, value: &str) -> bool {
    let result = unsafe {
        host_storage_set(
            key.as_ptr() as i32, key.len() as i32,
            value.as_ptr() as i32, value.len() as i32,
        )
    };
    result > 0
}

fn http_get(url: &str) -> Option<String> {
    let method = "GET";
    let headers = "{}";
    let body = b"";
    let result_ptr = unsafe {
        host_http_request(
            method.as_ptr() as i32, method.len() as i32,
            url.as_ptr() as i32, url.len() as i32,
            headers.as_ptr() as i32, headers.len() as i32,
            body.as_ptr() as i32, body.len() as i32,
        )
    };
    if result_ptr <= 0 { return None; }
    read_result(result_ptr)
}

fn read_result(ptr: i32) -> Option<String> {
    unsafe {
        let rp = ptr as usize;
        let len_bytes = slice::from_raw_parts(rp as *const u8, 4);
        let len = u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
        if len == 0 { return None; }
        let data = slice::from_raw_parts((rp + 4) as *const u8, len);
        String::from_utf8(data.to_vec()).ok()
    }
}

// ============================================================
// JSON utilities
// ============================================================

fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let search = format!("\"{}\"", key);
    let pos = json.find(&search)?;
    let rest = &json[pos + search.len()..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    if !after.starts_with('"') { return None; }

    let bytes = after.as_bytes();
    let mut i = 1;
    let mut result_bytes: Vec<u8> = Vec::new();
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if i + 1 < bytes.len() => {
                match bytes[i + 1] {
                    b'"' => { result_bytes.push(b'"'); i += 2; }
                    b'\\' => { result_bytes.push(b'\\'); i += 2; }
                    b'n' => { result_bytes.push(b'\n'); i += 2; }
                    b'r' => { result_bytes.push(b'\r'); i += 2; }
                    b't' => { result_bytes.push(b'\t'); i += 2; }
                    b'/' => { result_bytes.push(b'/'); i += 2; }
                    _ => { result_bytes.push(b'\\'); result_bytes.push(bytes[i + 1]); i += 2; }
                }
            }
            b'"' => return String::from_utf8(result_bytes).ok(),
            b => { result_bytes.push(b); i += 1; }
        }
    }
    None
}

fn extract_json_number(json: &str, key: &str) -> Option<i64> {
    let search = format!("\"{}\"", key);
    let pos = json.find(&search)?;
    let rest = &json[pos + search.len()..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim_start();
    let mut num_str = String::new();
    for ch in after.chars() {
        if ch.is_ascii_digit() || ch == '-' { num_str.push(ch); }
        else if !num_str.is_empty() { break; }
    }
    num_str.parse().ok()
}

fn escape_json_string(s: &str) -> String {
    s.replace('\\', "\\\\")
     .replace('"', "\\\"")
     .replace('\n', "\\n")
     .replace('\r', "\\r")
     .replace('\t', "\\t")
}

fn write_output(json: &str) -> i32 {
    let bytes = json.as_bytes();
    let total = 4 + bytes.len();
    let layout = match Layout::from_size_align(total, 1) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    let ptr = unsafe { alloc(layout) };
    if ptr.is_null() { return 0; }
    let len_bytes = (bytes.len() as u32).to_le_bytes();
    unsafe {
        std::ptr::copy_nonoverlapping(len_bytes.as_ptr(), ptr, 4);
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.add(4), bytes.len());
    }
    ptr as i32
}

// ============================================================
// IP geolocation lookup
// ============================================================

fn lookup_ip(ip: &str, api_url_template: &str, display_level: &str) -> Option<String> {
    let url = api_url_template
        .replace("{ip}", ip)
        .replace("{lang}", "zh-CN");

    log("info", &format!("ip-location: looking up IP {}", ip));

    let response = http_get(&url)?;
    let body = extract_json_string(&response, "body")?;

    let status = extract_json_string(&body, "status").unwrap_or_default();
    if status != "success" {
        log("warn", &format!("ip-location: API returned status={} for {}", status, ip));
        return None;
    }

    let region = extract_json_string(&body, "regionName").unwrap_or_default();
    let city = extract_json_string(&body, "city").unwrap_or_default();

    let location = match display_level {
        "city" => {
            if region == city || city.is_empty() {
                region
            } else {
                format!("{}{}", region, city)
            }
        }
        _ => region,
    };

    if location.is_empty() { None } else { Some(location) }
}

// ============================================================
// Storage helpers: article-level location map
// ============================================================

/// Read the location map for an article: {"comment_id":"location",...}
fn get_article_locs(article_id: i64) -> String {
    let key = format!("article_locs:{}", article_id);
    storage_get(&key).unwrap_or_else(|| "{}".to_string())
}

/// Add/update a location entry in the article map
fn set_article_loc(article_id: i64, comment_id: i64, location: &str) {
    let key = format!("article_locs:{}", article_id);
    let existing = get_article_locs(article_id);

    // Simple JSON map manipulation: insert "comment_id":"location"
    let entry = format!("\"{}\":\"{}\"", comment_id, escape_json_string(location));

    let new_map = if existing == "{}" {
        format!("{{{}}}", entry)
    } else {
        // Insert before the closing brace
        let trimmed = existing.trim();
        if trimmed.ends_with('}') {
            format!("{},{}}}", &trimmed[..trimmed.len()-1], entry)
        } else {
            format!("{{{}}}", entry)
        }
    };

    if storage_set(&key, &new_map) {
        log("info", &format!("ip-location: stored loc for comment {} in article {}", comment_id, article_id));
    }
}

// ============================================================
// Hook: comment_after_create (Action hook)
// ============================================================

#[no_mangle]
pub extern "C" fn hook_comment_after_create(ptr: i32, len: i32) -> i32 {
    if ptr <= 0 || len <= 0 || len > 1024 * 1024 { return 0; }

    let input = unsafe {
        let slice = slice::from_raw_parts(ptr as *const u8, len as usize);
        match std::str::from_utf8(slice) {
            Ok(s) => s,
            Err(_) => return 0,
        }
    };

    let enabled = extract_json_string(input, "enabled").unwrap_or_else(|| "true".to_string());
    if enabled == "false" { return 0; }

    let comment_id = match extract_json_number(input, "id") {
        Some(id) if id > 0 => id,
        _ => { log("warn", "ip-location: no comment id"); return 0; }
    };

    let article_id = match extract_json_number(input, "article_id") {
        Some(id) if id > 0 => id,
        _ => { log("warn", "ip-location: no article_id"); return 0; }
    };

    let ip = match extract_json_string(input, "ip") {
        Some(ip) if !ip.is_empty() => ip,
        _ => { log("info", "ip-location: no IP in hook data, skipping"); return 0; }
    };

    // Skip localhost IPs (can't geolocate)
    if ip == "127.0.0.1" || ip == "::1" {
        log("info", &format!("ip-location: skipping localhost IP {}", ip));
        return 0;
    }

    let api_url = extract_json_string(input, "api_url")
        .unwrap_or_else(|| "http://ip-api.com/json/{ip}?fields=status,regionName,city&lang=zh-CN".to_string());
    let display_level = extract_json_string(input, "display_level")
        .unwrap_or_else(|| "province".to_string());

    let location = match lookup_ip(&ip, &api_url, &display_level) {
        Some(loc) => loc,
        None => { log("warn", &format!("ip-location: lookup failed for {}", ip)); return 0; }
    };

    // Store in article-level map
    set_article_loc(article_id, comment_id, &location);

    0 // Action hook, return value ignored
}

// ============================================================
// API handler: GET /api/v1/plugins/ip-location/api/locations?article_id=X
// ============================================================

#[no_mangle]
pub extern "C" fn handle_request(ptr: i32, len: i32) -> i32 {
    if ptr <= 0 || len <= 0 || len > 1024 * 1024 { return 0; }

    let input = unsafe {
        let slice = slice::from_raw_parts(ptr as *const u8, len as usize);
        match std::str::from_utf8(slice) {
            Ok(s) => s,
            Err(_) => return 0,
        }
    };

    // Extract path and query from request
    // Input: {"method":"GET","path":"/locations","query":"article_id=1",...}
    let path = extract_json_string(input, "path").unwrap_or_default();
    let query = extract_json_string(input, "query").unwrap_or_default();

    if path == "/locations" || path == "locations" {
        return handle_get_locations(&query);
    }

    // 404 for unknown paths
    let resp = r#"{"status":404,"content_type":"application/json","body":"{\"error\":\"not found\"}"}"#;
    write_output(resp)
}

fn handle_get_locations(query: &str) -> i32 {
    // Parse article_id from query string
    let article_id = query
        .split('&')
        .find_map(|part| {
            let mut kv = part.splitn(2, '=');
            let key = kv.next()?;
            let val = kv.next()?;
            if key == "article_id" { val.parse::<i64>().ok() } else { None }
        });

    let article_id = match article_id {
        Some(id) if id > 0 => id,
        _ => {
            let resp = r#"{"status":400,"content_type":"application/json","body":"{\"error\":\"article_id required\"}"}"#;
            return write_output(resp);
        }
    };

    let locs = get_article_locs(article_id);

    let resp = format!(
        r#"{{"status":200,"content_type":"application/json","body":"{}"}}"#,
        escape_json_string(&locs)
    );
    write_output(&resp)
}
