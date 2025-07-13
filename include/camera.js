class OrbitCamera {
    constructor() {
        this.minDistance = -700;
        this.maxDistance = 2000;
        this.reset();
        this.rotationX = this.targetRotationX;
        this.rotationY = this.targetRotationY;
        this.center = this.targetCenter.copy();
        this.distance = this.targetDistance;

        this.sensitivity = 0.005;
        this.zoomSensitivity = 20;

        this.shiftPressed = false;
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.hashUpdateTimeout = null;

        window.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mouseup', () => this.onMouseUp());
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        window.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));

        // Add touch listeners
        window.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        window.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        window.addEventListener('touchend', (e) => this.onTouchEnd(e));

        // To track touches and gestures
        this.touchData = {
            isRotating: false,
            isPanning: false,
            initialPinchDistance: 0,
            initialDistance: this.targetDistance,
            startX: 0,
            startY: 0,
            moved: false,
        };

        this.restoreCameraStateFromBase64();
        let self = this;
        document.querySelector('#bu-reset').addEventListener('click', function(e) {
            self.reset();
        });
    }

    reset() {
        this.rotationX = this.rotationX % (Math.PI * 2.0);
        this.rotationY = this.rotationY % (Math.PI * 2.0);
        this.targetRotationX = radians(20);
        this.targetRotationY = radians(20);
        this.targetDistance = -300;
        this.targetCenter = createVector(0, 0, 0);
    }

    restoreCameraStateFromBase64() {
        if (!location.hash) return;
        try {
            const base64 = location.hash.substring(1);
            const json = decodeURIComponent(atob(base64));
            const state = JSON.parse(json);
            if (state.length === 6) {
                this.rotationX = state[0];
                this.rotationY = state[1];
                this.distance = state[2];
                this.center.x = state[3];
                this.center.y = state[4];
                this.center.z = state[5];
                this.targetRotationX = this.rotationX;
                this.targetRotationY = this.rotationY;
                this.targetDistance = this.distance;
                this.targetCenter = this.center.copy();
            }
        } catch (e) {
            console.warn("Failed to restore camera state from hash:", e);
        }
    }

    updateCameraHashThrottled() {
        clearTimeout(this.hashUpdateTimeout);
        this.hashUpdateTimeout = setTimeout(() => {
            let json = this.getCameraStateJSON();
            let base64 = btoa(json);
            location.hash = base64;
        }, 300);
    }

    onKeyDown(e) {
        if (e.key === 'Shift') this.shiftPressed = true;
    }

    onKeyUp(e) {
        if (e.key === 'Shift') this.shiftPressed = false;
    }

    onMouseDown(e) {
        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
    }

    onMouseUp() {
        this.isDragging = false;
        this.updateCameraHashThrottled();
    }

    // Helper to get distance between two touches
    getPinchDistance(touches) {
        if (touches.length < 2) return 0;
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    onTouchStart(e) {
        const touches = e.touches;
        this.touchData.startX = touches[0].clientX;
        this.touchData.startY = touches[0].clientY;
        this.touchData.moved = false;

        if (touches.length === 1) {
            this.touchData.isRotating = true;
            this.lastTouchX = touches[0].clientX;
            this.lastTouchY = touches[0].clientY;
        } else if (touches.length === 2) {
            this.touchData.isRotating = false;
            this.touchData.isPanning = true;
            this.touchData.initialPinchDistance = this.getPinchDistance(touches);
            this.touchData.initialDistance = this.targetDistance;
            this.touchData.lastMidX = (touches[0].clientX + touches[1].clientX) / 2;
            this.touchData.lastMidY = (touches[0].clientY + touches[1].clientY) / 2;
        }
    }

    onTouchMove(e) {
        const touches = e.touches;
        const moveThreshold = 5; // pixels

        if (this.touchData.isRotating && touches.length === 1) {
            const dx = touches[0].clientX - this.lastTouchX;
            const dy = touches[0].clientY - this.lastTouchY;

            // Mark moved if over threshold
            if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) {
                this.touchData.moved = true;
            }

            this.lastTouchX = touches[0].clientX;
            this.lastTouchY = touches[0].clientY;

            if (this.touchData.moved) {
                e.preventDefault();  // only prevent default if dragging
                this.targetRotationY += dx * this.sensitivity;
                this.targetRotationX += dy * this.sensitivity;
                this.targetRotationX = Math.min(Math.max(this.targetRotationX, -Math.PI / 2 + 0.1), Math.PI / 2 - 0.1);
            }
        } else if (this.touchData.isPanning && touches.length === 2) {
            const newPinchDistance = this.getPinchDistance(touches);
            const pinchDelta = newPinchDistance - this.touchData.initialPinchDistance;

            if (Math.abs(pinchDelta) > moveThreshold) {
                this.touchData.moved = true;
            }

            const midX = (touches[0].clientX + touches[1].clientX) / 2;
            const midY = (touches[0].clientY + touches[1].clientY) / 2;
            const dx = midX - this.touchData.lastMidX;
            const dy = midY - this.touchData.lastMidY;

            if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold || Math.abs(pinchDelta) > moveThreshold) {
                this.touchData.moved = true;
            }

            if (this.touchData.moved) {
                e.preventDefault();  // only prevent default if dragging or zooming

                this.targetDistance = this.touchData.initialDistance - pinchDelta * 0.5;
                this.targetDistance = Math.min(Math.max(this.targetDistance, this.minDistance), this.maxDistance);

                let right = this.getRotatedRightVector();
                let up = this.getRotatedUpVector();
                this.targetCenter.add(p5.Vector.mult(right, -dx));
                this.targetCenter.add(p5.Vector.mult(up, dy));

                this.touchData.lastMidX = midX;
                this.touchData.lastMidY = midY;
            }
        }
    }

    onTouchEnd(e) {
        if (this.touchData.moved) {
            this.updateCameraHashThrottled();
        }
        this.touchData.isRotating = false;
        this.touchData.isPanning = false;
        this.touchData.moved = false;
    }

    getRotatedUpVector() {
        let up = createVector(0, 1, 0);

        let sinX = Math.sin(-this.rotationX);
        let cosX = Math.cos(-this.rotationX);
        let y1 = up.y * cosX - up.z * sinX;
        let z1 = up.y * sinX + up.z * cosX;
        up.y = y1;
        up.z = z1;

        let sinY = Math.sin(-this.rotationY);
        let cosY = Math.cos(-this.rotationY);
        let x1 = up.x * cosY + up.z * sinY;
        let z2 = -up.x * sinY + up.z * cosY;
        up.x = x1;
        up.z = z2;

        return up;
    }

    getRotatedRightVector() {
        let right = createVector(1, 0, 0);

        let sinX = Math.sin(-this.rotationX);
        let cosX = Math.cos(-this.rotationX);
        let y1 = right.y * cosX - right.z * sinX;
        let z1 = right.y * sinX + right.z * cosX;
        right.y = y1;
        right.z = z1;

        let sinY = Math.sin(-this.rotationY);
        let cosY = Math.cos(-this.rotationY);
        let x1 = right.x * cosY + right.z * sinY;
        let z2 = -right.x * sinY + right.z * cosY;
        right.x = x1;
        right.z = z2;

        return right;
    }

    printVector(v) {
        let x = 0.0 + v.x;
        let y = 0.0 + v.y;
        let z = 0.0 + v.z;
        console.log(`${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`)
    }

    onMouseMove(e) {
        if (!this.isDragging) return;
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (this.shiftPressed) {
            let right = this.getRotatedRightVector();
            this.targetCenter.add(p5.Vector.mult(right, -dx));
            this.targetCenter.add(p5.Vector.mult(this.getRotatedUpVector(), dy));
        } else {
            this.targetRotationY += dx * this.sensitivity;
            this.targetRotationX += dy * this.sensitivity;
            this.targetRotationX = Math.min(Math.max(this.targetRotationX, -Math.PI / 2 + 0.1), Math.PI / 2 - 0.1);
        }
    }

    getCameraStateJSON() {
        const state = [
            this.rotationX,
            this.rotationY,
            this.distance,
            this.center.x,
            this.center.y,
            this.center.z,
        ];

        function roundValues(obj) {
            if (typeof obj === 'number') {
                return Number(obj.toFixed(2));
            } else if (typeof obj === 'object') {
                for (let key in obj) {
                    obj[key] = roundValues(obj[key]);
                }
                return obj;
            }
            return obj;
        }

        return JSON.stringify(roundValues(state));
    }


    onWheel(e) {
        this.targetDistance += e.deltaY * this.zoomSensitivity * 0.01;
        this.targetDistance = Math.min(Math.max(this.targetDistance, this.minDistance), this.maxDistance);
        this.updateCameraHashThrottled();
    }

    update() {
        const lerpFactor = 0.1;
        this.rotationX += (this.targetRotationX - this.rotationX) * lerpFactor;
        this.rotationY += (this.targetRotationY - this.rotationY) * lerpFactor;
        this.distance += (this.targetDistance - this.distance) * lerpFactor;
        this.center.x += (this.targetCenter.x - this.center.x) * lerpFactor;
        this.center.y += (this.targetCenter.y - this.center.y) * lerpFactor;
        this.center.z += (this.targetCenter.z - this.center.z) * lerpFactor;
    }

    apply(pg) {
        this.update();

        pg.scale(1, -1, 1);
        pg.translate(0, 0, -this.distance);
        pg.rotateX(this.rotationX);
        pg.rotateY(this.rotationY);
        pg.translate(-this.center.x, -this.center.y, -this.center.z);
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
