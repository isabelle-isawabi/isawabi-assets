// ─────────────────────────────────────────────
// Brik Component — image-only, no video, no border
// ─────────────────────────────────────────────

(function () {
  var _isMobile = window.innerWidth <= 768;
  if (_isMobile) {
    var _nativeDPR = window.devicePixelRatio || 1;
    var _cappedDPR = Math.min(1.5, _nativeDPR);
    Object.defineProperty(window, "devicePixelRatio", {
      get: function () {
        return _cappedDPR;
      },
    });
  }
})();

window.loadImage = function (src, callback) {
  var img = new Image();
  if (src && typeof src === "string" && !src.startsWith("data:")) {
    img.crossOrigin = "anonymous";
  }
  img.onload = function () {
    if (callback) callback(img);
  };
  img.onerror = function () {
    console.error("Failed to load image:", src);
  };
  img.src = src;
  return img;
};

// ─── Controls ───────────────────────────────
var controls = (function () {
  var _v = {
    image_src: "https://references.isawabi.com/Act%203%20-%20main.jpg",
    image_size: 1.75,
    enable_distortion: true,
    color_offset: 0.4,
    blur: 0,
    sheen_val: 0,
    gloss_val: 0,
    highlight_intensity_val: 0.1,
    highlight_softness_val: 1,
    light_direction_val: 45,
    softness: 1,
    recovery: 0.01,
    damping: 0.9,
    idle_intensity: 1.8,
    idle_trigger: "Continuous",
    enable_cursor_influence: true,
    cursor_force: 0.8,
    influence_radius_val: 0.7,
    anisotropy: 3.9,
    velocity_stretch: 0.5,
    bg_color_val: "#121212",
  };

  var api = {
    get: function (k) {
      return _v[k];
    },
    set: function (k, v) {
      _v[k] = v;
    },
    onAny: function () {},
  };
  window.ControlsAPI = api;
  return api;
})();

// ─── Three.js scene (ES module) ─────────────
import * as THREE from "https://esm.sh/three@0.170.0";

let area, scene, camera, renderer;
let geometry, material, mesh, meshGroup;
let positions, velocities, originalPositions;
let raycaster, mouse, mouseVelocity, opticalVec;
let isInteracting = false,
  isOverMesh = false;
let idleAlpha = 0,
  prevRotX = 0,
  prevRotY = 0;
let currentTexture = null;
let visibilityObserver,
  isVisible = false;

const clock = new THREE.Clock();
const _size = new THREE.Vector2();
const textureLoader = new THREE.TextureLoader();

// ─── Shaders ────────────────────────────────
const vertexShader = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vNormal    = normalize(normalMatrix * normal);
    vViewDir   = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  uniform sampler2D uTexture;
  uniform float uSheen;
  uniform float uGloss;
  uniform float uHighlightIntensity;
  uniform float uHighlightSoftness;
  uniform float uLightAngle;
  uniform vec3  uBackgroundColor;
  uniform vec2  uAspect;
  uniform vec2  uMeshSize;
  uniform bool  uEnableDistortion;
  uniform vec2  uOpticalOffset;
  uniform float uColorOffset;
  uniform float uBlur;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  float getObjectCoverage(vec2 p, vec2 aspect) {
    float d = sdRoundedBox(p, aspect * 0.5, 0.0);
    return smoothstep(0.01, -0.01, d);
  }

  vec4 getObjectColor(vec2 p, vec2 aspect, sampler2D tex, bool isDistortion, vec3 bgColor) {
    float d     = sdRoundedBox(p, aspect * 0.5, 0.0);
    float alpha = smoothstep(0.01, -0.01, d);
    if (alpha <= 0.0) return vec4(0.0);
    vec2 uv = (p / aspect) + 0.5;

    if (isDistortion) {
      vec3 rgb = texture2D(tex, uv).rgb;
      return vec4(mix(bgColor, rgb, alpha), alpha);
    }
    vec4 texColor = texture2D(tex, uv);
    return vec4(texColor.rgb, alpha);
  }

  void main() {
    vec2 p       = (vUv - 0.5) * uMeshSize;
    vec3 normal  = normalize(vNormal);
    vec3 viewDir = normalize(vViewDir);
    vec3 bgColor = uBackgroundColor;

    vec4 texColor;
    if (uEnableDistortion) {
      float activity  = length(uOpticalOffset);
      float smearDist = activity * 0.06 * uBlur;
      float chromaDist = activity * 0.022 * uColorOffset;

      if (smearDist < 0.0001 && chromaDist < 0.0001) {
        texColor = getObjectColor(p, uAspect, uTexture, false, bgColor);
      } else {
        float curvature     = length(fwidth(normal.xy));
        float steeringWeight = 1.5 / (1.0 + curvature * 8.0);
        vec2 globalDir  = normalize(uOpticalOffset + vec2(1e-6));
        vec2 currentDir = normalize(uOpticalOffset + normal.xy * steeringWeight + vec2(1e-6));
        vec2 dir        = normalize(mix(globalDir, currentDir, 0.35));

        vec4  accum      = vec4(0.0);
        float totalAlpha = 0.0;
        const int SAMPLES = 8;
        for (int i = 0; i < SAMPLES; i++) {
          float t  = float(i) / float(SAMPLES - 1);
          vec2  sp = p - dir * t * smearDist;

          vec4 p3  = getObjectColor(sp, uAspect, uTexture, true, bgColor);
          float lC = dot(p3.rgb, vec3(0.299, 0.587, 0.114));
          float lX = dot(getObjectColor(sp + vec2(0.01, 0.0), uAspect, uTexture, true, bgColor).rgb, vec3(0.299, 0.587, 0.114));
          float lY = dot(getObjectColor(sp + vec2(0.0, 0.01), uAspect, uTexture, true, bgColor).rgb, vec3(0.299, 0.587, 0.114));
          float grad = clamp(length(vec2(lX - lC, lY - lC)) * 10.0, 0.0, 1.0);
          float mod  = mix(0.75, 1.0, grad);

          float c1 = chromaDist * mod;
          float c2 = chromaDist * 0.5 * mod;

          vec4 p1 = getObjectColor(sp + dir * c1, uAspect, uTexture, true, bgColor);
          vec4 p2 = getObjectColor(sp + dir * c2, uAspect, uTexture, true, bgColor);
          vec4 p4 = getObjectColor(sp - dir * c2, uAspect, uTexture, true, bgColor);
          vec4 p5 = getObjectColor(sp - dir * c1, uAspect, uTexture, true, bgColor);

          float r  = p1.r * 1.0  + p2.r * 0.65 + p3.r * 0.25;
          float g  = p2.g * 0.45 + p3.g * 1.0  + p4.g * 0.45;
          float b  = p3.b * 0.25 + p4.b * 0.65 + p5.b * 1.0;
          float rW = 1.0 + 0.65 + 0.25;
          float gW = 0.45 + 1.0 + 0.45;
          float bW = 0.25 + 0.65 + 1.0;

          float ca = max(max(max(max(
            getObjectCoverage(sp + dir * c1, uAspect),
            getObjectCoverage(sp + dir * c2, uAspect)),
            getObjectCoverage(sp,            uAspect)),
            getObjectCoverage(sp - dir * c2, uAspect)),
            getObjectCoverage(sp - dir * c1, uAspect));

          accum.r  += r / rW;
          accum.g  += g / gW;
          accum.b  += b / bW;
          totalAlpha += ca;
        }
        texColor = totalAlpha > 0.001
          ? vec4(accum.rgb / float(SAMPLES), totalAlpha / float(SAMPLES))
          : vec4(0.0);
      }
    } else {
      texColor = getObjectColor(p, uAspect, uTexture, false, bgColor);
    }

    if (texColor.a <= 0.001) discard;

    float wrap            = dot(normal, vec3(0.0, 0.0, 1.0)) * 0.5 + 0.5;
    float deformShading   = mix(0.4, 1.0, wrap);
    vec3  shaded          = texColor.rgb * deformShading;

    float rad             = uLightAngle * 0.0174533;
    vec3  highlightDir    = normalize(vec3(cos(rad), sin(rad), 1.0));
    vec3  halfDir         = normalize(highlightDir + viewDir);
    float dotNH           = max(dot(normal, halfDir), 0.0);
    float dotNV           = max(dot(normal, viewDir),  0.0);
    float hExp            = pow(2.0, mix(7.0, 0.0, uHighlightSoftness));
    float specular        = pow(dotNH, hExp) * uHighlightIntensity;
    float sheenExp        = pow(2.0, mix(2.0, 8.0, uGloss));
    float sheenSpec       = pow(dotNH, sheenExp);
    float fresnel         = pow(1.0 - dotNV, 3.0);
    float sheenLayer      = (fresnel * 0.4 + sheenSpec) * uSheen;
    float highlight       = clamp(specular + sheenLayer, 0.0, 3.0);

    gl_FragColor = vec4(shaded + vec3(highlight), texColor.a);
  }
`;

// ─── Mesh init ──────────────────────────────
function initMesh() {
  const imageUrl = controls.get("image_src");

  textureLoader.load(imageUrl, (tex) => {
    currentTexture = tex;
    if (meshGroup) scene.remove(meshGroup);

    const width = tex.image.width;
    const height = tex.image.height;
    const aspect = width / height;
    const size = controls.get("image_size");
    let totalW = size,
      totalH = size;
    if (aspect > 1) {
      totalH = size / aspect;
    } else {
      totalW = size * aspect;
    }

    const maxRes = 200;
    const resX = aspect > 1 ? maxRes : Math.round(maxRes * aspect);
    const resY = aspect > 1 ? Math.round(maxRes / aspect) : maxRes;
    const margin = 1.4;
    const meshW = totalW * margin;
    const meshH = totalH * margin;

    geometry = new THREE.PlaneGeometry(meshW, meshH, resX, resY);
    const count = geometry.attributes.position.count;
    positions = geometry.attributes.position.array;
    originalPositions = new Float32Array(positions);
    velocities = new Float32Array(count).fill(0);

    const bgColor = controls.get("bg_color_val");

    material = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: tex },
        uSheen: { value: controls.get("sheen_val") },
        uGloss: { value: controls.get("gloss_val") },
        uHighlightIntensity: { value: controls.get("highlight_intensity_val") },
        uHighlightSoftness: { value: controls.get("highlight_softness_val") },
        uLightAngle: { value: controls.get("light_direction_val") },
        uBackgroundColor: { value: new THREE.Color(bgColor) },
        uAspect: { value: new THREE.Vector2(totalW, totalH) },
        uMeshSize: { value: new THREE.Vector2(meshW, meshH) },
        uEnableDistortion: { value: controls.get("enable_distortion") },
        uOpticalOffset: { value: new THREE.Vector2(0, 0) },
        uColorOffset: { value: controls.get("color_offset") },
        uBlur: { value: controls.get("blur") },
      },
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
      transparent: true,
    });

    mesh = new THREE.Mesh(geometry, material);
    meshGroup = new THREE.Group();
    meshGroup.add(mesh);
    scene.add(meshGroup);

    // Set solid background colour
    renderer.setClearColor(bgColor, 1);

    handleResize();
  });
}

// ─── Resize ─────────────────────────────────
function handleResize() {
  if (!area || !renderer || !camera) return;

  const width = area.clientWidth;
  const height = area.clientHeight;
  if (!width || !height) return;

  renderer.setSize(width, height, false);
  camera.aspect = width / height;

  if (material && material.uniforms && material.uniforms.uAspect) {
    const aspectVec = material.uniforms.uAspect.value;
    const totalW = aspectVec.x;
    const totalH = aspectVec.y;
    const defaultZ = 6;
    const padding = 1.08;
    const fovRad = (camera.fov * Math.PI) / 180;
    const reqZHeight = (totalH * padding) / (2 * Math.tan(fovRad / 2));
    const reqZWidth =
      (totalW * padding) / (width / height) / (2 * Math.tan(fovRad / 2));
    camera.position.z = Math.max(defaultZ, reqZHeight, reqZWidth);
  }

  camera.updateProjectionMatrix();
}

// ─── Animate ────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  if (!isVisible || !meshGroup || !mesh || !geometry) return;

  const dt = clock.getDelta();
  const time = clock.getElapsedTime();

  const rotVelX = meshGroup.rotation.x - prevRotX;
  const rotVelY = meshGroup.rotation.y - prevRotY;
  prevRotX = meshGroup.rotation.x;
  prevRotY = meshGroup.rotation.y;

  // Uniform updates
  if (material && material.uniforms) {
    const u = material.uniforms;
    if (u.uSheen) u.uSheen.value = controls.get("sheen_val");
    if (u.uGloss) u.uGloss.value = controls.get("gloss_val");
    if (u.uHighlightIntensity)
      u.uHighlightIntensity.value = controls.get("highlight_intensity_val");
    if (u.uHighlightSoftness)
      u.uHighlightSoftness.value = controls.get("highlight_softness_val");
    if (u.uLightAngle)
      u.uLightAngle.value = controls.get("light_direction_val");
    if (u.uEnableDistortion)
      u.uEnableDistortion.value = controls.get("enable_distortion");
    if (u.uColorOffset) u.uColorOffset.value = controls.get("color_offset");
    if (u.uBlur) u.uBlur.value = controls.get("blur");
  }

  const softness = controls.get("softness");
  const recovery = controls.get("recovery");
  const damping = controls.get("damping");
  const idle = controls.get("idle_intensity");
  const idleTrigger = controls.get("idle_trigger");
  const enableCursor = controls.get("enable_cursor_influence");

  // Tilt
  const targetTiltX = isInteracting ? mouse.y * (1 - softness) * 0.2 : 0;
  const targetTiltY = isInteracting ? mouse.x * (1 - softness) * 0.2 : 0;
  meshGroup.rotation.x += (targetTiltX - meshGroup.rotation.x) * 0.05;
  meshGroup.rotation.y += (targetTiltY - meshGroup.rotation.y) * 0.05;

  // Raycast
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(mesh);
  let hitPoint = null;
  isOverMesh = intersects.length > 0;
  if (isOverMesh) {
    hitPoint = intersects[0].point.clone();
    mesh.worldToLocal(hitPoint);
  }

  // Idle alpha
  const targetIdleAlpha =
    idleTrigger === "Continuous" || (idleTrigger === "On Hover" && isOverMesh)
      ? 1
      : 0;
  idleAlpha += (targetIdleAlpha - idleAlpha) * 0.05;

  // Mesh deformation
  const radiusVal = controls.get("influence_radius_val");
  const shapeStretch = controls.get("anisotropy");
  const motionStretch = controls.get("velocity_stretch");
  const velLen = mouseVelocity.length();
  const velDir = mouseVelocity.clone().normalize();
  const stretchAngle = Math.atan2(velDir.y, velDir.x);
  const cosA = Math.cos(-stretchAngle);
  const sinA = Math.sin(-stretchAngle);
  const stretchFactor = 1 + velLen * motionStretch * 100;

  if (!material || !material.uniforms || !material.uniforms.uMeshSize) return;
  const meshSize = material.uniforms.uMeshSize.value;
  const meshW = meshSize.x;
  const meshH = meshSize.y;
  const sigma = radiusVal * 0.05;
  const invTwoSigmaSq = 1 / (2 * sigma * sigma);
  const cursorForce = controls.get("cursor_force");
  const influenceFactor = -0.01 * softness * 1.5 * (cursorForce * cursorForce);

  const count = geometry.attributes.position.count;
  let totalMeshVel = 0;

  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    const x = originalPositions[idx];
    const y = originalPositions[idx + 1];
    const z = positions[idx + 2];

    let force = (0 - z) * recovery;

    if (enableCursor && hitPoint && isOverMesh) {
      let dx = (x - hitPoint.x) / meshW;
      let dy = (y - hitPoint.y) / meshH;
      if (motionStretch > 0 && velLen > 0.0001) {
        const rx = dx * cosA - dy * sinA;
        const ry = dx * sinA + dy * cosA;
        dx = rx / stretchFactor;
        dy = ry;
      }
      dx /= shapeStretch;
      const distSq = dx * dx + dy * dy;
      if (distSq < sigma * sigma * 16) {
        force += influenceFactor * Math.exp(-distSq * invTwoSigmaSq);
      }
    }

    if (idle > 0 && idleAlpha > 0.001) {
      const softnessShape = THREE.MathUtils.lerp(0.25, 1.0, softness);
      const freq = THREE.MathUtils.lerp(32.0, 18.0, softness);
      const idleNormalized = idle / 2.0;
      const driftSpeed = THREE.MathUtils.lerp(1.0, 1.45, idleNormalized);
      const nx = x / meshW;
      const ny = y / meshH;
      const phase = (nx * 0.75 + ny * 0.45) * freq + time * 1.35 * driftSpeed;
      const wave = Math.sin(phase);
      const idleScale = meshW / 5.32;
      force +=
        wave * softnessShape * softness * 0.001 * idle * idleAlpha * idleScale;
    }

    velocities[i] = (velocities[i] + force) * damping;
    positions[idx + 2] += velocities[i];
    totalMeshVel += Math.abs(velocities[i]);
  }

  // Optical distortion
  if (material) {
    const reactivity = controls.get("reactivity") || 0.4;
    const avgMeshVel = totalMeshVel / count;

    let tx = rotVelY * 100.0;
    let ty = -rotVelX * 100.0;
    tx += mouseVelocity.x * avgMeshVel * 1000.0;
    ty += mouseVelocity.y * avgMeshVel * 1000.0;

    if (avgMeshVel > 0.0001) {
      tx += Math.cos(time * 3.0) * avgMeshVel * 200.0;
      ty += Math.sin(time * 3.0) * avgMeshVel * 200.0;
    }

    opticalVec.x = THREE.MathUtils.lerp(opticalVec.x, tx * reactivity, 0.1);
    opticalVec.y = THREE.MathUtils.lerp(opticalVec.y, ty * reactivity, 0.1);

    if (material.uniforms && material.uniforms.uOpticalOffset) {
      material.uniforms.uOpticalOffset.value.copy(opticalVec);
    }
  }

  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
  mouseVelocity.multiplyScalar(0.9);
  renderer.render(scene, camera);
}

// ─── Main init (called by Webflow JS) ───────
window.initBrikCanvas = function () {
  area = document.querySelector(".brik-canvas-area");
  if (!area) {
    console.warn("Brik: .brik-canvas-area not found");
    return;
  }

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    45,
    area.clientWidth / area.clientHeight,
    0.1,
    1000,
  );
  camera.position.z = 6;

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
  });
  const DPR = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(DPR);
  renderer.setSize(area.clientWidth, area.clientHeight, false);
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  area.appendChild(renderer.domElement);

  window.renderer = renderer;
  window.scene = scene;
  window.camera = camera;

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2(-999, -999);
  mouseVelocity = new THREE.Vector2(0, 0);
  opticalVec = new THREE.Vector2(0, 0);

  initMesh();

  // Mouse events
  renderer.domElement.addEventListener("mousemove", (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    const nextX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const nextY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    if (isInteracting) mouseVelocity.set(nextX - mouse.x, nextY - mouse.y);
    mouse.set(nextX, nextY);
    isInteracting = true;
  });

  renderer.domElement.addEventListener("mouseleave", () => {
    isInteracting = false;
    isOverMesh = false;
    mouseVelocity.set(0, 0);
  });

  // Visibility observer — pauses render loop when off-screen
  visibilityObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        isVisible = e.isIntersecting;
      });
    },
    { threshold: 0.01 },
  );
  visibilityObserver.observe(area);

  // Resize observer
  new ResizeObserver(() => {
    requestAnimationFrame(handleResize);
  }).observe(area);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) requestAnimationFrame(handleResize);
  });

  window.addEventListener("resize", handleResize);
  setTimeout(handleResize, 100);

  animate();
};
