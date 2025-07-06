class OrbitCamera {
    constructor() {
        this.minDistance = -700;
        this.maxDistance = 2000;
        this.rotationX = this.targetRotationX = radians(20); // tilt down
        this.rotationY = this.targetRotationY = radians(20);  // rotate around target
        this.distance = -300;

        this.sensitivity = 0.005;
        this.zoomSensitivity = 20;

        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.targetDistance = this.distance;

        // Bind event handlers
        window.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mouseup', () => this.onMouseUp());
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    }

    onMouseDown(e) {
        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
    }

    onMouseUp() {
        this.isDragging = false;
    }

    onMouseMove(e) {
        if (!this.isDragging) return;
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;

        this.targetRotationY += dx * this.sensitivity;
        this.targetRotationX += dy * this.sensitivity;

        // Clamp vertical rotation to avoid flipping
        this.targetRotationX = Math.min(Math.max(this.targetRotationX, -Math.PI / 2 + 0.1), Math.PI / 2 - 0.1);

        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
    }

    onWheel(e) {
        this.targetDistance += e.deltaY * this.zoomSensitivity * 0.01;
        this.targetDistance = Math.min(Math.max(this.targetDistance, this.minDistance), this.maxDistance);
    }

    update() {
        // Smooth interpolation for rotation and zoom
        const lerpFactor = 0.1;
        this.rotationX += (this.targetRotationX - this.rotationX) * lerpFactor;
        this.rotationY += (this.targetRotationY - this.rotationY) * lerpFactor;
        this.distance += (this.targetDistance - this.distance) * lerpFactor;
    }

    apply(pg) {
        this.update();

        pg.scale(1, -1, 1);
        // Translate back by distance
        pg.translate(0, 0, -this.distance);
        // Apply rotations
        pg.rotateX(this.rotationX);
        pg.rotateY(this.rotationY);
    }
}

class FlyCamera {
    constructor() {
        this.position = createVector(0, 0, 0);
        this.yaw = 0;
        this.pitch = 0;

        this.sensitivity = 0.002;

        this.velocity = createVector(0, 0, 0);
        this.acceleration = createVector(0, 0, 0);
        this.maxSpeed = 10;
        this.accelerationRate = 0.5;
        this.friction = 0.85;

        this.keys = { w: false, a: false, s: false, d: false, space: false, ctrl: false };

        // Bind events
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));

        // Pointer lock setup
        window.addEventListener('click', () => {
            if (document.pointerLockElement !== document.body) {
                document.body.requestPointerLock();
            }
        });

        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement === document.body) {
                document.addEventListener('mousemove', this.onMouseMoveBound = (e) => this.onMouseMove(e));
            } else {
                document.removeEventListener('mousemove', this.onMouseMoveBound);
            }
        });
    }

    onMouseMove(e) {
        // Use movementX and movementY from pointer lock for smooth relative rotation
        this.yaw += e.movementX * this.sensitivity;
        this.pitch += e.movementY * this.sensitivity;

        // Clamp pitch between -90 and +90 degrees, minus a small margin
        const maxPitch = Math.PI / 2 - 0.01;
        const minPitch = -maxPitch;
        this.pitch = Math.min(Math.max(this.pitch, minPitch), maxPitch);
    }

    onKeyDown(e) {
        switch (e.key.toLowerCase()) {
            case 'w': this.keys.w = true; break;
            case 'a': this.keys.a = true; break;
            case 's': this.keys.s = true; break;
            case 'd': this.keys.d = true; break;
            case ' ': this.keys.space = true; break;
            case 'control': this.keys.ctrl = true; break;
        }
    }

    onKeyUp(e) {
        switch (e.key.toLowerCase()) {
            case 'w': this.keys.w = false; break;
            case 'a': this.keys.a = false; break;
            case 's': this.keys.s = false; break;
            case 'd': this.keys.d = false; break;
            case ' ': this.keys.space = false; break;
            case 'control': this.keys.ctrl = false; break;
        }
    }

    update() {
        // Calculate forward, right, and up vectors
        const cosPitch = Math.cos(-this.pitch);
        const sinPitch = Math.sin(-this.pitch);
        const cosYaw = Math.cos(this.yaw);
        const sinYaw = Math.sin(this.yaw);

        const forward = createVector(
            sinYaw * cosPitch,
            sinPitch,
            cosYaw * cosPitch
        ).normalize();

        const worldUp = createVector(0, 1, 0);
        const right = forward.copy().cross(worldUp).normalize();
        const up = right.copy().cross(forward).normalize();

        // Reset acceleration
        this.acceleration.set(0, 0, 0);

        // Movement input
        if (this.keys.w) this.acceleration.add(forward);
        if (this.keys.s) this.acceleration.sub(forward);
        if (this.keys.a) this.acceleration.sub(right);
        if (this.keys.d) this.acceleration.add(right);
        if (this.keys.space) this.acceleration.add(up);
        if (this.keys.ctrl) this.acceleration.sub(up);

        if (this.acceleration.magSq() > 0) {
            this.acceleration.normalize().mult(this.accelerationRate);
            this.velocity.add(this.acceleration);
            if (this.velocity.mag() > this.maxSpeed) {
                this.velocity.setMag(this.maxSpeed);
            }
        } else {
            this.velocity.mult(this.friction);
            if (this.velocity.mag() < 0.01) this.velocity.set(0, 0, 0);
        }

        this.position.add(this.velocity);
    }

    apply(pg) {
        this.update();

        pg.scale(1, -1, 1);
        pg.translate(0, 0, 800);
        pg.rotateX(this.pitch);
        pg.rotateY(this.yaw);
        pg.translate(-this.position.x, -this.position.y, this.position.z);
    }
}
