let anaglyph;
let camera;
let models = {};
let tex = {};
let sceneDescription;
let enableAnaglyph = true;

function parseSceneINI(text) {
    const objects = [];
    let current = { transform: [], _lineStart: 1 }; // line where current object starts
    const errors = [];

    const lines = text.split(/\r?\n/);

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        let trimmed = line.trim();

        // Skip comments and empty lines handling
        if (trimmed.startsWith('#') || trimmed.startsWith(';')) return;

        if (!trimmed) {
            // New object block if current has content
            if (Object.keys(current).length > 2 || current.transform.length > 0) {
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

        // Parse key and value
        const [keyRaw, ...rest] = trimmed.split('=');
        if (!keyRaw || rest.length === 0) {
            errors.push(`Syntaxfehler in Zeile ${lineNumber}: fehlendes '='`);
            return;
        }

        const key = keyRaw.trim();
        const rawValue = rest.join('=').trim();

        // Parse arrays for move, rotate, scale
        let value = rawValue.includes(',') ? rawValue.split(',').map(s => s.trim()) : rawValue;

        // Validate known keys or provide helpful messages:
        let t = 0.0;
        if (key === 'shape') {
            if (value !== 'box' && value !== 'torus' && value !== 'cone' && value !== 'cylinder' && value !== 'sphere' && value !== 'plane' && value !== 'grid') {
                errors.push(`Ungültige Form (shape) in Zeile ${lineNumber}: "${value}". Gültige Werte sind: box, torus, cone, cylinder, sphere, plane, grid.`);
            }
            if (Object.keys(current).length > 2 || current.transform.length > 0) {
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
                    eval(value);
                } catch (e) {
                    errors.push(`Ungültiger Wert für Füllfarbe (fill) in Zeile ${lineNumber}: "${value}".`);
                }
            }
        }
        if (key === 'stroke') {
            if (value !== 'off') {
                try {
                    eval(value);
                } catch (e) {
                    errors.push(`Ungültiger Wert für Strichfarbe (stroke) in Zeile ${lineNumber}: "${value}".`);
                }
            }
        }

        if (key === 'move' || key === 'rotate' || key === 'scale') {
            if (typeof(value) === 'string') {
                value = [value, value, value];
            }
            // Store line for this transform
            current.transform.push({ type: key, value, _line: lineNumber });
        } else {
            // Store value and line
            current[key] = value;
            current[`_${key}_line`] = lineNumber;
        }
    });

    // Push last object if exists
    if (Object.keys(current).length > 1 || current.transform.length > 0) {
        objects.push(current);
    }

    // Reverse transform order for each object
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
                    models[entry.model] = loadModel(entry.model, false);
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
                    pg.stroke(eval(entry.stroke) * 255);
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
                    pg.fill(eval(entry.fill) * 255);
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
                enableAnaglyph = (entry.anaglyph === 'on');
                if (enableAnaglyph) {
                    anaglyph.shaderLoaded = true;
                } else {
                    anaglyph.shaderLoaded = false;
                    // pg.scale(1, -1, 1); // flip y-axis for non-anaglyph mode
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
}
