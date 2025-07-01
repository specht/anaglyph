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
