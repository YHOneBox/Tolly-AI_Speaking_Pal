use futures_util::StreamExt;

use crate::error::ApiError;

pub async fn collect_frames(
    response: reqwest::Response,
    mut on_frame: impl FnMut(&str) -> Result<bool, ApiError>,
) -> Result<(), ApiError> {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|err| ApiError::upstream(0, err.to_string()))?;
        buffer.extend_from_slice(&chunk);
        if buffer.len() > 8 * 1024 * 1024 {
            return Err(ApiError::upstream(0, "The streamed response was too large."));
        }

        while let Some(end) = find_frame_end(&buffer) {
            let frame: Vec<u8> = buffer.drain(..end).collect();
            let text = String::from_utf8_lossy(&frame);
            let data = sse_data(&text);
            if data.is_empty() {
                continue;
            }
            let finished = on_frame(&data)?;
            if finished {
                return Ok(());
            }
        }
    }

    if !buffer.is_empty() {
        let text = String::from_utf8_lossy(&buffer);
        let data = sse_data(&text);
        if !data.is_empty() {
            on_frame(&data)?;
        }
    }
    Ok(())
}

fn find_frame_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| index + 2)
        .or_else(|| {
            buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
        })
}

fn sse_data(frame: &str) -> String {
    let mut data = String::new();
    for line in frame.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim_start());
        }
    }
    data
}
