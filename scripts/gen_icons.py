import struct, zlib, os

def crc32b(data): return zlib.crc32(data) & 0xffffffff

def png_chunk(chunk_type, data):
    c = chunk_type.encode() + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', crc32b(c))

def build_png(size):
    cx, cy = size/2, size/2
    r1, r2, r3 = size*0.499, size*0.40, size*0.26
    rows = b''
    for y in range(size):
        row = b'\x00'
        for x in range(size):
            dx, dy = x+0.5-cx, y+0.5-cy
            d = (dx*dx+dy*dy)**0.5
            r,g,b,a = 0,0,0,0
            if d <= r1: r,g,b,a = 13,17,23,255
            if d <= r2: r,g,b,a = 255,107,53,255
            if d <= r3: r,g,b,a = 13,17,23,255
            if size >= 32 and d <= r3:
                nx, ny = dx/r3, dy/r3
                sl = abs(nx+0.38) < 0.18
                sr = abs(nx-0.38) < 0.18
                bar = abs(ny) < 0.10 and -0.55 < nx < 0.55
                if -0.68 < ny < 0.68 and (sl or sr or bar):
                    r,g,b,a = 255,107,53,255
            row += bytes([r,g,b,a])
        rows += row
    compressed = zlib.compress(rows, 6)
    sig = bytes([137,80,78,71,13,10,26,10])
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return sig + png_chunk('IHDR', ihdr) + png_chunk('IDAT', compressed) + png_chunk('IEND', b'')

os.makedirs('assets/icons', exist_ok=True)
for sz in [16, 32, 48, 128]:
    with open(f'assets/icons/icon{sz}.png', 'wb') as f:
        f.write(build_png(sz))
    print(f'ok icon{sz}.png')
