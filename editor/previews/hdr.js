(function () {
  const radiancePattern = /#\?RADIANCE/;
  const commentPattern = /#.*/;
  const exposurePattern = /EXPOSURE=\s*([0-9]*[.][0-9]*)/;
  const formatPattern = /FORMAT=32-bit_rle_rgbe/;
  const widthHeightPattern = /-Y ([0-9]+) \+X ([0-9]+)/;

  function readPixelsRawRLE(buffer, data, offset, fileOffset, scanlineWidth, numScanlines) {
    var rgbe = new Array(4), scanlineBuffer = null, ptr, ptrEnd, count, buf = new Array(2), bufferLength = buffer.length;
    function readBuf(out) { var bytesRead = 0; do { out[bytesRead++] = buffer[fileOffset]; } while (++fileOffset < bufferLength && bytesRead < out.length); return bytesRead; }
    function readBufOffset(out, off, length) { var bytesRead = 0; do { out[off + bytesRead++] = buffer[fileOffset]; } while (++fileOffset < bufferLength && bytesRead < length); return bytesRead; }
    function readPixelsRaw(out, off, count) { var expected = 4 * count, got = readBufOffset(out, off, expected); if (got < expected) throw new Error('Error reading raw pixels: got ' + got + ' bytes, expected ' + expected); }
    while (numScanlines > 0) {
      if (readBuf(rgbe) < 4) throw new Error('Error reading bytes: expected 4');
      if ((rgbe[0] != 2) || (rgbe[1] != 2) || ((rgbe[2] & 0x80) != 0)) { data[offset++] = rgbe[0]; data[offset++] = rgbe[1]; data[offset++] = rgbe[2]; data[offset++] = rgbe[3]; readPixelsRaw(data, offset, scanlineWidth * numScanlines - 1); return; }
      if ((((rgbe[2] & 255) << 8) | (rgbe[3] & 255)) != scanlineWidth) throw new Error('Wrong scanline width');
      if (!scanlineBuffer) scanlineBuffer = new Array(4 * scanlineWidth);
      ptr = 0;
      for (var i = 0; i < 4; i++) {
        ptrEnd = (i + 1) * scanlineWidth;
        while (ptr < ptrEnd) {
          if (readBuf(buf) < 2) throw new Error('Error reading 2-byte buffer');
          if ((buf[0] & 255) > 128) {
            count = (buf[0] & 255) - 128;
            if (!count || count > ptrEnd - ptr) throw new Error('Bad scanline data');
            while (count-- > 0) scanlineBuffer[ptr++] = buf[1];
          } else {
            count = buf[0] & 255;
            if (!count || count > ptrEnd - ptr) throw new Error('Bad scanline data');
            scanlineBuffer[ptr++] = buf[1];
            if (--count > 0) { if (readBufOffset(scanlineBuffer, ptr, count) < count) throw new Error('Error reading non-run data'); ptr += count; }
          }
        }
      }
      for (var x = 0; x < scanlineWidth; x++) {
        data[offset++] = scanlineBuffer[x];
        data[offset++] = scanlineBuffer[x + scanlineWidth];
        data[offset++] = scanlineBuffer[x + 2 * scanlineWidth];
        data[offset++] = scanlineBuffer[x + 3 * scanlineWidth];
      }
      numScanlines--;
    }
  }
  function parseHdr(buffer) {
    if (buffer instanceof ArrayBuffer) buffer = new Uint8Array(buffer);
    var fileOffset = 0, bufferLength = buffer.length;
    function readLine() { var buf = ''; do { var b = buffer[fileOffset]; if (b === 10) { ++fileOffset; break; } buf += String.fromCharCode(b); } while (++fileOffset < bufferLength); return buf; }
    var width = 0, height = 0, exposure = 1, gamma = 1, rle = false;
    for (var i = 0; i < 20; i++) {
      var line = readLine(), match;
      if ((match = line.match(radiancePattern))) {}
      else if ((match = line.match(formatPattern))) rle = true;
      else if ((match = line.match(exposurePattern))) exposure = Number(match[1]);
      else if ((match = line.match(commentPattern))) {}
      else if ((match = line.match(widthHeightPattern))) { height = Number(match[1]); width = Number(match[2]); break; }
    }
    if (!rle) throw new Error('File is not run length encoded!');
    var data = new Uint8Array(width * height * 4);
    readPixelsRawRLE(buffer, data, 0, fileOffset, width, height);
    var floatData = new Float32Array(width * height * 4);
    for (var offset = 0; offset < data.length; offset += 4) {
      var r = data[offset] / 255, g = data[offset + 1] / 255, b = data[offset + 2] / 255, e = data[offset + 3], f = Math.pow(2, e - 128);
      floatData[offset] = r * f; floatData[offset + 1] = g * f; floatData[offset + 2] = b * f; floatData[offset + 3] = 1;
    }
    return { shape: [width, height], exposure, gamma, data: floatData };
  }
  async function toPNG(ctx) {
    const hdr = parseHdr(ctx.readBinary());
    const [width, height] = hdr.shape;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      for (let c = 0; c < 3; c++) {
        let val = hdr.data[idx + c];
        val = val / (0.3 + val);
        val = Math.pow(val, 1 / 2.2);
        rgba[idx + c] = Math.max(0, Math.min(255, val * 255));
      }
      rgba[idx + 3] = 255;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas.toDataURL('image/png');
  }
  window.EditorPreviewProviders = window.EditorPreviewProviders || [];
  window.EditorPreviewProviders.push({
    id: 'hdr',
    match(file) { return file.mime === 'image/vnd.radiance'; },
    views: [{
      id: 'hdr-preview',
      label: 'Preview',
      default: true,
      priority: 120,
      async create(ctx) {
        const img = document.createElement('img');
        img.className = 'editor-image';
        img.src = await toPNG(ctx);
        ctx.host.appendChild(img);
      }
    }]
  });
})();
