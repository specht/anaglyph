let anaglyph;
let camera;
let models = {};
let tex = {};
let sceneDescription;
let enableAnaglyph = true;
let enableAxes = false;
let firstFrame = true;

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
                errors.push(`Fehlendes Schlüsselwirt 'end' für Gruppe (group) ab Zeile ${lineStart}`);
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

    const lines = text.split(/\r?\n/);

    lines.forEach((line, index) => {
        const lineNumber = lineMap?.[index] ?? (index + 1);
        let trimmed = line.trim();

        if (trimmed.startsWith('#') || trimmed.startsWith(';')) return;

        if (!trimmed) {
            if ((Object.keys(current).length > 2 || current.transform.length > 0) && current.command !== 'push') {
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

        let value = splitArgs(rawValue);
        if (value.length === 1) value = value[0];

        let t = 0.0;
        if (key === 'command' && (value === 'push' || value === 'pop')) {
            objects.push(current);
            current = { transform: [], _lineStart: lineNumber + 1 };
        }
        if (key === 'shape') {
            if (value !== 'box' && value !== 'torus' && value !== 'cone' && value !== 'cylinder' && value !== 'sphere' && value !== 'plane' && value !== 'grid') {
                errors.push(`Ungültige Form (shape) in Zeile ${lineNumber}: "${value}". Gültige Werte sind: box, torus, cone, cylinder, sphere, plane, grid.`);
            }
            if ((Object.keys(current).length > 2 || current.transform.length > 0)) {
                objects.push(current);
                current = { transform: [], _lineStart: lineNumber + 1 };
            }
        }
        if (key === 'model') {
            if (Object.keys(current).length > 2 || current.transform.length > 0) {
                objects.push(current);
                current = { transform: [], _lineStart: lineNumber + 1 };
            }
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
            if (value !== 'off') {
                try {
                    try {
                        eval(value);
                    } catch(e) {
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
                    } catch(e) {
                        if (!isValidColor(value)) throw "nope";
                    }
                } catch (e) {
                    errors.push(`Ungültiger Wert für Strichfarbe (stroke) in Zeile ${lineNumber}: "${value}".`);
                }
            }
        }

        if (key === 'move' || key === 'rotate' || key === 'scale') {
            if (typeof (value) === 'string') {
                value = [value, value, value];
            }
            current.transform.push({ type: key, value, _line: lineNumber });
        } else {
            current[key] = value;
            current[`_${key}_line`] = lineNumber;
        }
    });

    if (Object.keys(current).length > 1 || current.transform.length > 0) {
        objects.push(current);
    }

    objects.forEach(obj => {
        obj.transform ??= [];
        obj.transform.reverse();
    });

    return { objects, errors };
}

function preload() {
    fetch('scene.ini')
    .then(response => response.text())
    .then(text => {
        x = parseSceneINI(text);
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
    .catch(error => console.error('Fehler in scene.ini!', error));
};

function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    anaglyph = createAnaglyph(this);
    camera = new OrbitCamera();
    // camera = new FlyCamera();
    window.anaglyph_fonts = {};
    window.anaglyph_fonts.OpenSans = loadFont('include/OpenSans-Regular.ttf');
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
    pg.text("x", -3, 3)
    pg.pop();

    pg.push();
    pg.strokeWeight(5);
    pg.stroke('#4aa03f');
    pg.line(0, 0, 0, 0, 100, 0);
    pg.translate(0, 110, 0);
    pg.rotateY(-camera.rotationY);
    pg.rotateX(-camera.rotationX);
    pg.scale(1, -1, 1);
    pg.text("y", -3, 3)
    pg.pop();

    pg.push();
    pg.strokeWeight(5);
    pg.stroke('#0d60ae');
    pg.line(0, 0, 0, 0, 0, 100);
    pg.translate(0, 0, 110);
    pg.rotateY(-camera.rotationY);
    pg.rotateX(-camera.rotationX);
    pg.scale(1, -1, 1);
    pg.text("z", -3, 3)
    pg.pop();

    pg.pop();
}

function renderScene(pg) {
    pg.background(255);

    if (enableAxes) {
        drawAxes(pg);
    }

    pg.strokeWeight(2);
    pg.stroke(0);
    pg.fill(255);
    let t = millis() / 1000;
    for (let entry of sceneDescription) {
        try {
            if (entry.command === 'push') {
                pg.push();
                for (let tr of entry.transform ?? []) {
                    if (tr.type === 'move') {
                        pg.translate(eval(tr.value[0]), eval(tr.value[1]), eval(tr.value[2]));
                    } else if (tr.type === 'rotate') {
                        pg.rotateX(eval(tr.value[0]) / 180 * Math.PI);
                        pg.rotateY(eval(tr.value[1]) / 180 * Math.PI);
                        pg.rotateZ(eval(tr.value[2]) / 180 * Math.PI);
                    } else if (tr.type === 'scale') {
                        pg.scale(eval(tr.value[0]), eval(tr.value[1]), eval(tr.value[2]));
                    }
                }
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
                } else {
                    pg.ambientLight(64);
                    pg.directionalLight(255, 255, 255, 0.5, 0.5, -1);

                }
            }
            if (entry.anaglyph) {
                if (firstFrame) {
                    enableAnaglyph = (entry.anaglyph === 'on');
                    anaglyph.shaderLoaded = enableAnaglyph;
                }
            }
            if (entry.shape || entry.model) {
                pg.push();
                for (let tr of entry.transform ?? []) {
                    if (tr.type === 'move') {
                        pg.translate(eval(tr.value[0]), eval(tr.value[1]), eval(tr.value[2]));
                    } else if (tr.type === 'rotate') {
                        pg.rotateX(eval(tr.value[0]) / 180 * Math.PI);
                        pg.rotateY(eval(tr.value[1]) / 180 * Math.PI);
                        pg.rotateZ(eval(tr.value[2]) / 180 * Math.PI);
                    } else if (tr.type === 'scale') {
                        pg.scale(eval(tr.value[0]), eval(tr.value[1]), eval(tr.value[2]));
                    }
                }
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
            if (entry.command === 'pop') {
                pg.pop();
            }
        } catch (error) {
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
    document.querySelector('#bu-anaglyph').addEventListener('click', function(e) {
        enableAnaglyph = !enableAnaglyph;
        anaglyph.shaderLoaded = enableAnaglyph;
    });
    document.querySelector('#bu-axes').addEventListener('click', function(e) {
        enableAxes = !enableAxes;
    });
});