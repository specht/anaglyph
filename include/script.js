let anaglyph;
let camera;
let models = {};
let tex = {};
let sceneDescription;
let enableAnaglyph = true;
let firstFrame = true;

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

function unrollLoops(source) {
    const lines = source.split('\n');
    const errors = [];

    const lineMap = []; // maps unrolled line index -> original source line number

    function expand(lines, parentLineNumber = 0, scope = {}) {
        let result = [];
        let localLineMap = [];
        let i = 0;

        while (i < lines.length) {
            const rawLine = lines[i];
            const line = rawLine.trim();
            const currentLineNumber = parentLineNumber + i;

            const loopMatch = line.match(/^loop\s+(\w+)\s+from\s+(-?\d+)\s+to\s+(-?\d+)(?:\s+step\s+(-?\d+))?/);
            if (loopMatch) {
                const [, varName, fromStr, toStr, stepStr] = loopMatch;
                const from = parseInt(fromStr, 10);
                const to = parseInt(toStr, 10);
                const step = stepStr ? parseInt(stepStr, 10) : (to >= from ? 1 : -1);
                if (step === 0) {
                    errors.push(`Ungültige Schrittgröße (step) 0 in Zeile ${currentLineNumber + 1}`);
                    i++;
                    continue;
                }

                // Find matching end
                let body = [];
                let bodyLineStart = i + 1;
                i++;
                let depth = 1;
                while (i < lines.length && depth > 0) {
                    const innerLine = lines[i].trim();
                    if (innerLine.startsWith('loop')) depth++;
                    else if (innerLine === 'end') depth--;
                    if (depth > 0) body.push(lines[i]);
                    i++;
                }

                if (depth !== 0) {
                    errors.push(`Fehlendes Schlüsselwort 'end' für die Schleife (loop) ab Zeile ${currentLineNumber + 1}`);
                    continue;
                }

                // Unroll loop
                for (
                    let val = from;
                    step > 0 ? val <= to : val >= to;
                    val += step
                ) {
                    const newScope = { ...scope, [varName]: val };
                    const { expanded, map } = expand(body, parentLineNumber + bodyLineStart, newScope);
                    result.push(...expanded);
                    localLineMap.push(...map);
                }
            } else if (line === 'end') {
                errors.push(`Überzähliges Schlüsselwort 'end' in Zeile ${currentLineNumber + 1}`);
                i++;
            } else {
                // Replace vars
                const substituted = rawLine.replace(/\b\w+\b/g, word =>
                    scope[word] !== undefined ? scope[word] : word
                );
                result.push(substituted);
                localLineMap.push(currentLineNumber + 1); // 1-based line number
                i++;
            }
        }

        return { expanded: result, map: localLineMap };
    }

    const { expanded, map } = expand(lines);
    return {
        output: expanded.join('\n'),
        errors,
        lineMap: map
    };
}

function parseSceneINI(text) {
    let errors = [];

    let temp = unrollLoops(text);
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
        console.log(lineNumber, trimmed);

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
        if (keyRaw !== 'push' && keyRaw !== 'pop') {
            if (!keyRaw || rest.length === 0) {
                errors.push(`Syntaxfehler in Zeile ${lineNumber}: fehlendes '='`);
                return;
            }
        }

        const key = keyRaw.trim();
        const rawValue = rest.join('=').trim();

        let value = splitArgs(rawValue);
        if (value.length === 1) value = value[0];

        let t = 0.0;
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
        console.log(obj);
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

function renderScene(pg) {
    pg.background(255);
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
            if (entry.command === 'pop') {
                pg.pop();
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
});