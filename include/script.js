let anaglyph;
let camera;
let models = {};
let tex = {};
let sceneDescription;
let firstFrame = true;

// Extruded text support
const DEFAULT_TEXT_FONT = 'OpenSans';
const DEFAULT_TEXT_FONT_PATH = 'include/OpenSans-Regular.ttf';
const DEFAULT_TEXT_DETAIL = 8;

let fontBytes = {};
let textFonts = {};
let extrudedTextCache = new Map();
let shownRuntimeErrors = new Set();

function preprocessSceneINI(source) {
    const errors = [];
    const lineMap = []; // maps expanded line index -> original line number (1-based)

    function expand(lines, parentLine = 0, scope = {}) {
        const result = [];
        const map = [];
        let i = 0;
        const stack = [];

        while (i < lines.length) {
            const rawLine = lines[i];
            const trimmed = rawLine.trim();
            const lineNumber = parentLine + i;

            const loopMatch = trimmed.match(/^loop\s+(\w+)\s+from\s+(-?\d+)\s+to\s+(-?\d+)(?:\s+step\s+(-?\d+))?/);
            if (loopMatch) {
                const [, varName, fromStr, toStr, stepStr] = loopMatch;
                const from = parseInt(fromStr, 10);
                const to = parseInt(toStr, 10);
                const step = stepStr ? parseInt(stepStr, 10) : (to >= from ? 1 : -1);

                if (step === 0) {
                    errors.push(`Ungültige Schrittgröße (step) 0 in Zeile ${lineNumber + 1}`);
                    i++;
                    continue;
                }

                let body = [];
                let depth = 1;
                let startLine = i + 1;
                i++;

                while (i < lines.length && depth > 0) {
                    const innerLine = lines[i].trim();
                    if (innerLine.startsWith('loop') || innerLine.startsWith('group')) depth++;
                    else if (innerLine === 'end') depth--;
                    if (depth > 0) body.push(lines[i]);
                    i++;
                }

                if (depth !== 0) {
                    errors.push(`Fehlendes Schlüsselwort 'end' für Schleife (loop) ab Zeile ${lineNumber + 1}`);
                    continue;
                }

                for (let val = from; step > 0 ? val <= to : val >= to; val += step) {
                    const newScope = { ...scope, [varName]: val };
                    const { expanded, map: innerMap } = expand(body, parentLine + startLine, newScope);
                    result.push(...expanded);
                    map.push(...innerMap);
                }
                continue;
            }

            if (trimmed === 'group') {
                const indent = rawLine.match(/^\s*/)?.[0] ?? '';
                result.push(`${indent}command = push`);
                map.push(lineNumber + 1);
                stack.push(lineNumber + 1); // track for error reporting
                i++;
                continue;
            }

            if (trimmed === 'end') {
                const indent = rawLine.match(/^\s*/)?.[0] ?? '';
                if (stack.length === 0) {
                    errors.push(`Überzähliges Schlüsselwort 'end' in Zeile ${lineNumber + 1}`);
                    result.push(rawLine); // preserve for better debugging
                } else {
                    stack.pop();
                    result.push(`${indent}command = pop`);
                }
                map.push(lineNumber + 1);
                i++;
                continue;
            }

            // Substitute loop variables
            const substituted = rawLine.replace(/\b\w+\b/g, word =>
                scope[word] !== undefined ? scope[word] : word
            );
            result.push(substituted);
            map.push(lineNumber + 1);
            i++;
        }

        if (stack.length > 0) {
            for (const lineStart of stack) {
                errors.push(`Fehlendes Schlüsselwort 'end' für Gruppe (group) ab Zeile ${lineStart}`);
            }
        }

        return { expanded: result, map };
    }

    const lines = source.split(/\r?\n/);
    const { expanded, map } = expand(lines);
    return {
        output: expanded.join('\n'),
        errors,
        lineMap: map
    };
}

function splitArgs(line) {
    const args = [];
    let current = '';
    let depth = 0;

    for (let char of line) {
        if (char === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
        } else {
            if (char === '(') depth++;
            if (char === ')') depth--;
            current += char;
        }
    }

    if (current.trim()) args.push(current.trim());
    return args;
}

function replaceGroupsWithPushPop(text) {
    const lines = text.split(/\r?\n/);
    const stack = [];
    const output = [];
    let errors = [];

    for (let i = 0; i < lines.length; i++) {
        const originalLine = lines[i];
        const trimmed = originalLine.trim();

        if (trimmed === 'group') {
            stack.push(i);
            const indent = originalLine.match(/^\s*/)[0] ?? '';
            output.push(`${indent}command = push`);
        } else if (trimmed === 'end') {
            if (stack.length === 0) {
                errors.push(`Überzähliges Schlüsselwort 'end' in Zeile ${i + 1}`);
                output.push(originalLine); // keep original
            } else {
                stack.pop();
                const indent = originalLine.match(/^\s*/)[0] ?? '';
                output.push(`${indent}command = pop`);
            }
        } else {
            output.push(originalLine);
        }
    }

    if (stack.length > 0) {
        for (const lineIndex of stack) {
            errors.push(`Unclosed 'group' starting at line ${lineIndex + 1}`);
        }
    }

    return {
        output: output.join('\n'),
        errors
    };
}

function parseSceneINI(text) {
    let errors = [];

    let temp = preprocessSceneINI(text);
    text = temp.output;
    errors = temp.errors;
    const lineMap = temp.lineMap;

    const objects = [];
    let current = { transform: [], _lineStart: 1 };

    function currentHasContent() {
        const keys = Object.keys(current).filter(key => key !== 'transform' && key !== '_lineStart');
        return keys.length > 0 || current.transform.length > 0;
    }

    function pushCurrentAndStartNew(lineNumber) {
        if (currentHasContent()) {
            objects.push(current);
        }
        current = { transform: [], _lineStart: lineNumber };
    }

    const lines = text.split(/\r?\n/);

    lines.forEach((line, index) => {
        const lineNumber = lineMap?.[index] ?? (index + 1);
        let trimmed = line.trim();

        if (trimmed.startsWith('#') || trimmed.startsWith(';')) return;

        if (!trimmed) {
            if (currentHasContent()) {
                objects.push(current);
                current = { transform: [], _lineStart: lineNumber + 1 };
            }
            return;
        }

        if (!trimmed.includes('=') && trimmed.includes(' ')) {
            const firstSpace = trimmed.indexOf(' ');
            line = trimmed.slice(0, firstSpace) + '=' + trimmed.slice(firstSpace + 1);
            trimmed = line.trim();
        }

        const [keyRaw, ...rest] = trimmed.split('=');
        if (!keyRaw || rest.length === 0) {
            if (keyRaw !== 'group' && keyRaw !== 'end') {
                errors.push(`Syntaxfehler in Zeile ${lineNumber}: fehlendes '='`);
                return;
            }
        }

        const key = keyRaw.trim();
        const rawValue = rest.join('=').trim();

        let value;

        if (key === 'text') {
            // Text may contain commas, so do not split it into arguments.
            value = rawValue;
        } else {
            value = splitArgs(rawValue);
            if (value.length === 1) value = value[0];
        }

        if (key === 'command' && (value === 'push' || value === 'pop')) {
            pushCurrentAndStartNew(lineNumber);
            current.command = value;
            current._command_line = lineNumber;
            return;
        }

        if (key === 'shape') {
            if (value !== 'box' && value !== 'torus' && value !== 'cone' && value !== 'cylinder' && value !== 'sphere' && value !== 'plane' && value !== 'grid') {
                errors.push(`Ungültige Form (shape) in Zeile ${lineNumber}: "${value}". Gültige Werte sind: box, torus, cone, cylinder, sphere, plane, grid.`);
            }
            pushCurrentAndStartNew(lineNumber);
        }

        if (key === 'model') {
            pushCurrentAndStartNew(lineNumber);
        }

        if (key === 'text') {
            pushCurrentAndStartNew(lineNumber);
        }

        if (key === 'shade') {
            if (value !== 'off' && value !== 'on') {
                try {
                    eval(value);
                } catch (e) {
                    errors.push(`Ungültiger Wert für Schattierung (shade) in Zeile ${lineNumber}: "${value}". Gültige Werte sind: off, on.`);
                }
            }
        }

        if (key === 'fill') {
            if (value !== 'off' && value !== 'shade') {
                try {
                    try {
                        eval(value);
                    } catch (e) {
                        if (!isValidColor(value)) throw "nope";
                    }
                } catch (e) {
                    errors.push(`Ungültiger Wert für Füllfarbe (fill) in Zeile ${lineNumber}: "${value}".`);
                }
            }
        }

        if (key === 'stroke') {
            if (value !== 'off') {
                try {
                    try {
                        eval(value);
                    } catch (e) {
                        if (!isValidColor(value)) throw "nope";
                    }
                } catch (e) {
                    errors.push(`Ungültiger Wert für Strichfarbe (stroke) in Zeile ${lineNumber}: "${value}".`);
                }
            }
        }

        if (key === 'move' || key === 'rotate' || key === 'scale') {
            if (typeof value === 'string') {
                value = [value, value, value];
            }
            current.transform.push({ type: key, value, _line: lineNumber });
        } else {
            current[key] = value;
            current[`_${key}_line`] = lineNumber;
        }
    });

    if (currentHasContent()) {
        objects.push(current);
    }

    objects.forEach(obj => {
        obj.transform ??= [];
        obj.transform.reverse();
    });

    return { objects, errors };
}

function preload() {
    window.anaglyph_fonts = {};
    window.anaglyph_fonts.OpenSans = loadFont(DEFAULT_TEXT_FONT_PATH);
    fontBytes.OpenSans = loadBytes(DEFAULT_TEXT_FONT_PATH);

    const params = new URLSearchParams(window.location.search);
    const sceneFile = params.get('scene') || 'scene.ini';

    fetch(sceneFile)
    .then(response => response.text())
    .then(text => {
        const x = parseSceneINI(text);
        sceneDescription = x.objects;

        for (let entry of sceneDescription) {
            if (entry.model) {
                if (!models[entry.model]) {
                    let path = entry.model;
                    if (path.indexOf('.') < 0)
                        path = path + '.obj';
                    models[entry.model] = loadModel(path, false);
                }

                let kit = entry.model.split('/')[0];
                let model = entry.model.split('/')[1].split('.')[0];

                if (!tex[kit]) {
                    tex[kit] = loadImage(`${kit}/textures/${model}.png`);
                }

                entry.model = models[entry.model];
                entry.tex = tex[kit];
            }
        }

        let errors = x.errors;
        if (errors.length > 0) {
            document.getElementById('errors').style.display = 'block';
            document.getElementById('errors').innerHTML = errors.map(e => `<p>${e}</p>`).join('');
        }
    })
    .catch(error => console.error(`Fehler in ${sceneFile}!`, error));
}

function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    anaglyph = createAnaglyph(this);
    camera = new OrbitCamera();
    // camera = new FlyCamera();

    if (typeof opentype === 'undefined') {
        reportRuntimeError(`opentype.js fehlt. Bitte include/opentype.min.js einbinden.`);
    } else {
        try {
            textFonts.OpenSans = parseOpenTypeFont(fontBytes.OpenSans);
        } catch (error) {
            reportRuntimeError(`Die Schrift ${DEFAULT_TEXT_FONT_PATH} konnte nicht gelesen werden: ${error.message}`);
        }
    }

    if (typeof earcut === 'undefined') {
        reportRuntimeError(`earcut fehlt. Bitte include/earcut.min.js einbinden.`);
    }
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
    anaglyph.init();
}

function draw() {
    anaglyph.draw(scene);
}

function drawGrid(pg) {
    pg.push();
    pg.stroke(180);
    for (let i = -500; i <= 500; i += 100) {
        pg.line(i, 0, -500, i, 0, 500);
        pg.line(-500, 0, i, 500, 0, i);
    }
    pg.pop();
}

function scene(pg) {
    camera.apply(pg);
    renderScene(pg);
}

function drawAxes(pg) {
    pg.push();
    pg.fill(0);
    pg.textFont(window.anaglyph_fonts.OpenSans, 10);

    pg.push();
    pg.strokeWeight(5);
    pg.stroke('#d5291a');
    pg.line(0, 0, 0, 100, 0, 0);
    pg.translate(110, 0, 0);
    pg.rotateY(-camera.rotationY);
    pg.rotateX(-camera.rotationX);
    pg.scale(1, -1, 1);
    pg.text("x", -3, 3);
    pg.pop();

    pg.push();
    pg.strokeWeight(5);
    pg.stroke('#4aa03f');
    pg.line(0, 0, 0, 0, 100, 0);
    pg.translate(0, 110, 0);
    pg.rotateY(-camera.rotationY);
    pg.rotateX(-camera.rotationX);
    pg.scale(1, -1, 1);
    pg.text("y", -3, 3);
    pg.pop();

    pg.push();
    pg.strokeWeight(5);
    pg.stroke('#0d60ae');
    pg.line(0, 0, 0, 0, 0, 100);
    pg.translate(0, 0, 110);
    pg.rotateY(-camera.rotationY);
    pg.rotateX(-camera.rotationX);
    pg.scale(1, -1, 1);
    pg.text("z", -3, 3);
    pg.pop();

    pg.pop();
}

function parseOpenTypeFont(bytesObject) {
    const bytes = bytesObject.bytes;
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const buffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
    return opentype.parse(buffer);
}

function reportRuntimeError(message) {
    if (shownRuntimeErrors.has(message)) return;
    shownRuntimeErrors.add(message);

    console.error(message);

    const errors = document.getElementById('errors');
    if (errors) {
        errors.style.display = 'block';
        const p = document.createElement('p');
        p.textContent = message;
        errors.appendChild(p);
    }
}

function evalSceneValue(expression, t) {
    return Function('t', `return (${expression});`)(t);
}

function applyTransforms(pg, transforms, t) {
    for (let tr of transforms ?? []) {
        if (tr.type === 'move') {
            pg.translate(
                evalSceneValue(tr.value[0], t),
                evalSceneValue(tr.value[1], t),
                evalSceneValue(tr.value[2], t)
            );
        } else if (tr.type === 'rotate') {
            pg.rotateX(evalSceneValue(tr.value[0], t) / 180 * Math.PI);
            pg.rotateY(evalSceneValue(tr.value[1], t) / 180 * Math.PI);
            pg.rotateZ(evalSceneValue(tr.value[2], t) / 180 * Math.PI);
        } else if (tr.type === 'scale') {
            pg.scale(
                evalSceneValue(tr.value[0], t),
                evalSceneValue(tr.value[1], t),
                evalSceneValue(tr.value[2], t)
            );
        }
    }
}

function renderExtrudedText(pg, entry, t) {
    const text = String(entry.text ?? '');
    if (text.length === 0) return;

    const fontName = entry.font || DEFAULT_TEXT_FONT;
    const font = textFonts[fontName];

    if (!font) {
        throw new Error(`Schriftart "${fontName}" wurde nicht geladen.`);
    }

    if (typeof earcut === 'undefined') {
        throw new Error(`earcut wurde nicht geladen.`);
    }

    const size = entry.size ? evalSceneValue(entry.size, t) : 100;
    const depth = entry.depth ? evalSceneValue(entry.depth, t) : 20;
    const align = entry.align || 'center';

    const cacheKey = JSON.stringify([fontName, text, size, depth, align]);
    let geometry = extrudedTextCache.get(cacheKey);

    if (!geometry) {
        geometry = createExtrudedTextGeometry(font, text, size, depth, align);
        geometry.gid = `extruded-text-${fontName}-${text}-${size}-${depth}-${align}`;
        extrudedTextCache.set(cacheKey, geometry);
    }

    pg.model(geometry);
}

function createExtrudedTextGeometry(font, text, size, depth, align, detail = DEFAULT_TEXT_DETAIL) {
    const path = font.getPath(text, 0, 0, size);
    let contours = pathToContours(path.commands, detail);

    contours = contours
        .map(cleanContour)
        .filter(contour => contour.length >= 3 && Math.abs(signedArea(contour)) > 0.001);

    const geometry = new p5.Geometry();

    if (contours.length === 0) {
        return geometry;
    }

    normalizeContours(contours, align);

    const infos = computeContourNesting(contours);
    const allPoints = [];

    for (const info of infos) {
        info.start = allPoints.length;
        for (const p of info.points) {
            allPoints.push(p);
        }
    }

    const frontZ = depth / 2;
    const backZ = -depth / 2;

    for (const p of allPoints) {
        geometry.vertices.push(createVector(p.x, p.y, frontZ));
    }

    const backOffset = allPoints.length;

    for (const p of allPoints) {
        geometry.vertices.push(createVector(p.x, p.y, backZ));
    }

    // Front and back faces. Every even-depth contour is treated as a solid island.
    // Its direct odd-depth children are passed to earcut as holes.
    for (const outer of infos.filter(info => info.depth % 2 === 0)) {
        const holes = infos.filter(info => info.parent === outer.index && info.depth === outer.depth + 1);

        const localPoints = [];
        const localToGlobal = [];
        const holeStarts = [];

        for (let i = 0; i < outer.points.length; i++) {
            localPoints.push(outer.points[i]);
            localToGlobal.push(outer.start + i);
        }

        for (const hole of holes) {
            holeStarts.push(localPoints.length);

            for (let i = 0; i < hole.points.length; i++) {
                localPoints.push(hole.points[i]);
                localToGlobal.push(hole.start + i);
            }
        }

        const flat = [];
        for (const p of localPoints) {
            flat.push(p.x, p.y);
        }

        const triangles = earcut(flat, holeStarts, 2);

        for (let i = 0; i < triangles.length; i += 3) {
            const a = triangles[i];
            const b = triangles[i + 1];
            const c = triangles[i + 2];

            const ia = localToGlobal[a];
            const ib = localToGlobal[b];
            const ic = localToGlobal[c];

            const triArea = triangleSignedArea(localPoints[a], localPoints[b], localPoints[c]);

            if (triArea >= 0) {
                geometry.faces.push([ia, ib, ic]);
                geometry.faces.push([backOffset + ia, backOffset + ic, backOffset + ib]);
            } else {
                geometry.faces.push([ia, ic, ib]);
                geometry.faces.push([backOffset + ia, backOffset + ib, backOffset + ic]);
            }
        }
    }

    // Side faces
    // Use separate vertices for the side walls. Otherwise p5 averages normals
    // between front/back faces and side walls, which makes extruded text look melted.
    for (const info of infos) {
        const points = info.points;
        const area = signedArea(points);

        // Outward direction depends on whether this contour is an outer boundary or a hole.
        const reverse = (area > 0) === (info.depth % 2 === 0);

        for (let i = 0; i < points.length; i++) {
            const j = (i + 1) % points.length;

            const p0 = points[i];
            const p1 = points[j];

            const base = geometry.vertices.length;

            geometry.vertices.push(createVector(p0.x, p0.y, frontZ));
            geometry.vertices.push(createVector(p1.x, p1.y, frontZ));
            geometry.vertices.push(createVector(p1.x, p1.y, backZ));
            geometry.vertices.push(createVector(p0.x, p0.y, backZ));

            if (reverse) {
                geometry.faces.push([base + 0, base + 2, base + 1]);
                geometry.faces.push([base + 0, base + 3, base + 2]);
            } else {
                geometry.faces.push([base + 0, base + 1, base + 2]);
                geometry.faces.push([base + 0, base + 2, base + 3]);
            }
        }
    }

    geometry.computeNormals();
    return geometry;
}

function pathToContours(commands, detail = DEFAULT_TEXT_DETAIL) {
    const contours = [];
    let current = [];
    let pen = { x: 0, y: 0 };

    function addPoint(x, y) {
        current.push({ x, y: -y });
    }

    function finishContour() {
        if (current.length > 0) {
            contours.push(current);
            current = [];
        }
    }

    for (const cmd of commands) {
        if (cmd.type === 'M') {
            finishContour();
            addPoint(cmd.x, cmd.y);
            pen = { x: cmd.x, y: cmd.y };
        } else if (cmd.type === 'L') {
            addPoint(cmd.x, cmd.y);
            pen = { x: cmd.x, y: cmd.y };
        } else if (cmd.type === 'Q') {
            const steps = Math.max(1, Math.round(detail));
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const x = quadratic(pen.x, cmd.x1, cmd.x, t);
                const y = quadratic(pen.y, cmd.y1, cmd.y, t);
                addPoint(x, y);
            }
            pen = { x: cmd.x, y: cmd.y };
        } else if (cmd.type === 'C') {
            const steps = Math.max(1, Math.round(detail * 1.5));
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                const x = cubic(pen.x, cmd.x1, cmd.x2, cmd.x, t);
                const y = cubic(pen.y, cmd.y1, cmd.y2, cmd.y, t);
                addPoint(x, y);
            }
            pen = { x: cmd.x, y: cmd.y };
        } else if (cmd.type === 'Z') {
            finishContour();
        }
    }

    finishContour();
    return contours;
}

function quadratic(a, b, c, t) {
    return (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;
}

function cubic(a, b, c, d, t) {
    return (1 - t) ** 3 * a +
        3 * (1 - t) ** 2 * t * b +
        3 * (1 - t) * t ** 2 * c +
        t ** 3 * d;
}

function cleanContour(points) {
    const cleaned = [];

    for (const p of points) {
        const last = cleaned[cleaned.length - 1];

        if (!last || distanceSquared(last, p) > 0.0001) {
            cleaned.push(p);
        }
    }

    if (cleaned.length > 1 && distanceSquared(cleaned[0], cleaned[cleaned.length - 1]) <= 0.0001) {
        cleaned.pop();
    }

    return cleaned;
}

function normalizeContours(contours, align) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const contour of contours) {
        for (const p of contour) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }
    }

    let offsetX;

    if (align === 'left') {
        offsetX = minX;
    } else if (align === 'right') {
        offsetX = maxX;
    } else {
        offsetX = (minX + maxX) / 2;
    }

    const offsetY = (minY + maxY) / 2;

    for (const contour of contours) {
        for (const p of contour) {
            p.x -= offsetX;
            p.y -= offsetY;
        }
    }
}

function computeContourNesting(contours) {
    const infos = contours.map((points, index) => ({
        points,
        index,
        parent: null,
        depth: 0,
        area: signedArea(points)
    }));

    for (const info of infos) {
        const p = info.points[0];
        let bestParent = null;
        let bestArea = Infinity;

        for (const candidate of infos) {
            if (candidate === info) continue;

            const candidateArea = Math.abs(candidate.area);
            const ownArea = Math.abs(info.area);

            if (candidateArea <= ownArea) continue;

            if (pointInPolygon(p, candidate.points) && candidateArea < bestArea) {
                bestParent = candidate.index;
                bestArea = candidateArea;
            }
        }

        info.parent = bestParent;
    }

    for (const info of infos) {
        let depth = 0;
        let parent = info.parent;

        while (parent !== null) {
            depth++;
            parent = infos[parent].parent;
        }

        info.depth = depth;
    }

    return infos;
}

function signedArea(points) {
    let area = 0;

    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        area += a.x * b.y - b.x * a.y;
    }

    return area / 2;
}

function triangleSignedArea(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInPolygon(point, polygon) {
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i];
        const b = polygon[j];

        const intersect =
            ((a.y > point.y) !== (b.y > point.y)) &&
            (point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x);

        if (intersect) inside = !inside;
    }

    return inside;
}

function distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function renderScene(pg) {
    pg.background(255);

    if (camera.enableAxes) {
        drawAxes(pg);
    }

    pg.strokeWeight(2);
    pg.stroke(0);
    pg.fill(255);

    let t = millis() / 1000;
    if (typeof sceneDescription === 'undefined') return;

    for (let entry of sceneDescription) {
        try {
            if (entry.command === 'push') {
                pg.push();
                applyTransforms(pg, entry.transform ?? [], t);
            }

            if (entry.background) {
                pg.background(eval(entry.background) * 255);
                continue;
            }

            if (entry.strokeWeight) {
                pg.strokeWeight(eval(entry.strokeWeight));
            }

            if (entry.stroke) {
                if (entry.stroke === 'off') {
                    pg.noStroke();
                } else {
                    try {
                        pg.stroke(eval(entry.stroke) * 255);
                    } catch (e) {
                        pg.stroke(entry.stroke);
                    }
                }
            }

            if (entry.fill) {
                if (entry.fill === 'off') {
                    pg.noFill();
                } else if (entry.fill === 'shade') {
                    pg.noLights();
                    pg.ambientLight(64);
                    pg.directionalLight(255, 255, 255, 0.5, 0.5, -1);
                    pg.fill(255);
                } else {
                    try {
                        pg.fill(eval(entry.fill) * 255);
                    } catch (e) {
                        pg.fill(entry.fill);
                    }
                }
            }

            if (entry.shade) {
                pg.noLights();
                if (entry.shade === 'off') {
                    // no lights
                } else {
                    pg.ambientLight(64);
                    pg.directionalLight(255, 255, 255, 0.5, 0.5, -1);
                }
            }

            if (entry.anaglyph) {
                if (firstFrame) {
                    camera.enableAnaglyph = (entry.anaglyph === 'on');
                }
            }

            anaglyph.shaderLoaded = camera.enableAnaglyph;

            if (entry.shape || entry.model) {
                pg.push();
                applyTransforms(pg, entry.transform ?? [], t);

                if (entry.shape === 'sphere') {
                    pg.sphere();
                } else if (entry.shape === 'box') {
                    pg.box();
                } else if (entry.shape === 'torus') {
                    pg.torus(50, 20);
                } else if (entry.shape === 'cone') {
                    pg.cone(50, 100);
                } else if (entry.shape === 'cylinder') {
                    pg.cylinder(50, 100);
                } else if (entry.shape === 'plane') {
                    pg.plane(100);
                } else if (entry.shape === 'grid') {
                    drawGrid(pg);
                }

                if (entry.model) {
                    if (entry.model instanceof p5.Geometry) {
                        pg.texture(entry.tex);
                        pg.scale(100, 100, 100);
                        pg.model(entry.model);
                    }
                }

                pg.pop();
            }

            if (entry.text !== undefined) {
                pg.push();
                applyTransforms(pg, entry.transform ?? [], t);
                renderExtrudedText(pg, entry, t);
                pg.pop();
            }

            if (entry.command === 'pop') {
                pg.pop();
            }
        } catch (error) {
            const lineInfo = entry._lineStart ? `Zeile ${entry._lineStart}: ` : '';
            reportRuntimeError(`${lineInfo}${error.message ?? error}`);
        }
    }

    firstFrame = false;
}

function isValidColor(str) {
    const s = new Option().style;
    s.color = str;
    return s.color !== '';
}

window.addEventListener('DOMContentLoaded', function(e) {
    const params = new URLSearchParams(window.location.search);
    const sceneFile = params.get('scene');
    if (sceneFile === null)
        this.window.location.search = `?scene=scene.ini`;

    document.querySelector('#bu-anaglyph').addEventListener('click', function(e) {
        camera.enableAnaglyph = !camera.enableAnaglyph;
        anaglyph.shaderLoaded = camera.enableAnaglyph;
    });

    document.querySelector('#bu-axes').addEventListener('click', function(e) {
        camera.enableAxes = !camera.enableAxes;
    });
});