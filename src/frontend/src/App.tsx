import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useActor } from "./hooks/useActor";

type GameState = "menu" | "playing" | "gameover" | "leaderboard";

interface ScoreEntry {
  playerName: string;
  survivalTime: number;
  timestamp: bigint;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Audio Engine ───────────────────────────────────────────────────────────

let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  if (_audioCtx.state === "suspended") {
    _audioCtx.resume();
  }
  return _audioCtx;
}

interface AudioRefs {
  drone1: OscillatorNode | null;
  drone2: OscillatorNode | null;
  droneGain: GainNode | null;
  droneGain2: GainNode | null;
  sawOsc: OscillatorNode | null;
  sawGain: GainNode | null;
  lfo: OscillatorNode | null;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  footstepInterval: ReturnType<typeof setInterval> | null;
}

function playScream() {
  const ctx = getAudioCtx();
  // White noise burst
  const bufSize = ctx.sampleRate * 0.3;
  const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = buffer;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.4, ctx.currentTime);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
  noiseSource.connect(noiseGain);
  noiseGain.connect(ctx.destination);
  noiseSource.start();
  noiseSource.stop(ctx.currentTime + 0.3);

  // Descending glide
  const glideOsc = ctx.createOscillator();
  const glideGain = ctx.createGain();
  glideOsc.frequency.setValueAtTime(800, ctx.currentTime);
  glideOsc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.5);
  glideGain.gain.setValueAtTime(0.35, ctx.currentTime);
  glideGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
  glideOsc.connect(glideGain);
  glideGain.connect(ctx.destination);
  glideOsc.start();
  glideOsc.stop(ctx.currentTime + 0.5);
}

function playHeartbeat(fast: boolean) {
  const ctx = getAudioCtx();
  const interval = fast ? 0.6 : 1.2;
  const lub = () => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 60;
    osc.type = "sine";
    g.gain.setValueAtTime(0.22, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  };
  const dub = () => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 55;
    osc.type = "sine";
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  };
  lub();
  setTimeout(dub, 300);
  return interval;
}

function playFootstep() {
  const ctx = getAudioCtx();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = 50;
  osc.type = "sine";
  g.gain.setValueAtTime(0.05, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.1);
}

function startAmbientDrone(refs: AudioRefs) {
  const ctx = getAudioCtx();

  // Drone 1: 40Hz sine
  const d1 = ctx.createOscillator();
  const g1 = ctx.createGain();
  d1.type = "sine";
  d1.frequency.value = 40;
  g1.gain.value = 0.08;
  d1.connect(g1);
  g1.connect(ctx.destination);
  d1.start();
  refs.drone1 = d1;
  refs.droneGain = g1;

  // Drone 2: 43Hz sine (beating effect)
  const d2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  d2.type = "sine";
  d2.frequency.value = 43;
  g2.gain.value = 0.08;
  d2.connect(g2);
  g2.connect(ctx.destination);
  d2.start();
  refs.drone2 = d2;
  refs.droneGain2 = g2;

  // Sawtooth + LPF + LFO
  const saw = ctx.createOscillator();
  const sawG = ctx.createGain();
  const lpf = ctx.createBiquadFilter();
  lpf.type = "lowpass";
  lpf.frequency.value = 200;
  saw.type = "sawtooth";
  saw.frequency.value = 80;
  sawG.gain.value = 0.06;
  saw.connect(lpf);
  lpf.connect(sawG);
  sawG.connect(ctx.destination);
  saw.start();
  refs.sawOsc = saw;
  refs.sawGain = sawG;

  const lfo = ctx.createOscillator();
  const lfoG = ctx.createGain();
  lfo.type = "sine";
  lfo.frequency.value = 0.3;
  lfoG.gain.value = 0.04;
  lfo.connect(lfoG);
  lfoG.connect(sawG.gain);
  lfo.start();
  refs.lfo = lfo;
}

function stopAmbientDrone(refs: AudioRefs) {
  try {
    refs.drone1?.stop();
  } catch {}
  try {
    refs.drone2?.stop();
  } catch {}
  try {
    refs.sawOsc?.stop();
  } catch {}
  try {
    refs.lfo?.stop();
  } catch {}
  refs.drone1 = null;
  refs.drone2 = null;
  refs.droneGain = null;
  refs.droneGain2 = null;
  refs.sawOsc = null;
  refs.sawGain = null;
  refs.lfo = null;
  if (refs.heartbeatInterval !== null) {
    clearInterval(refs.heartbeatInterval);
    refs.heartbeatInterval = null;
  }
  if (refs.footstepInterval !== null) {
    clearInterval(refs.footstepInterval);
    refs.footstepInterval = null;
  }
}

// ─── Trees ──────────────────────────────────────────────────────────────────

type TreeDef = {
  x: number;
  z: number;
  height: number;
  trunkR: number;
  id: number;
};

function Trees({ defs }: { defs: TreeDef[] }) {
  return (
    <>
      {defs.map((t) => (
        <group key={t.id} position={[t.x, 0, t.z]}>
          <mesh position={[0, t.height / 2, 0]} castShadow>
            <cylinderGeometry args={[t.trunkR * 0.5, t.trunkR, t.height, 5]} />
            <meshStandardMaterial color="#0a0a09" roughness={1} />
          </mesh>
          <mesh position={[0, t.height * 0.65, 0]}>
            <coneGeometry
              args={[2.2 + Math.random() * 0.8, t.height * 0.55, 6]}
            />
            <meshStandardMaterial color="#040704" roughness={1} />
          </mesh>
          <mesh position={[0, t.height * 0.82, 0]}>
            <coneGeometry args={[1.5, t.height * 0.4, 6]} />
            <meshStandardMaterial color="#050905" roughness={1} />
          </mesh>
        </group>
      ))}
    </>
  );
}

// ─── Blood Splatters ────────────────────────────────────────────────────────

type SplatDef = {
  x: number;
  z: number;
  size: number;
  rot: number;
  id: number;
  fresh: boolean;
  scaleX: number;
  scaleZ: number;
  satellites: { ox: number; oz: number; size: number; rot: number }[];
};

function BloodSplatters({ defs }: { defs: SplatDef[] }) {
  return (
    <>
      {defs.map((s) => (
        <group key={s.id}>
          {/* Main splatter */}
          <mesh
            position={[s.x, 0.01, s.z]}
            rotation={[-Math.PI / 2, 0, s.rot]}
            scale={[s.scaleX, s.scaleZ, 1]}
          >
            <circleGeometry args={[s.size, 8]} />
            <meshStandardMaterial
              color={s.fresh ? "#cc0000" : "#8b0000"}
              roughness={0.55}
              emissive={s.fresh ? "#440000" : "#220000"}
              emissiveIntensity={0.3}
            />
          </mesh>
          {/* Satellite drops */}
          {s.satellites.map((sat, si) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static geometry
            <mesh
              // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
              key={`sat-${si}`}
              position={[s.x + sat.ox, 0.012, s.z + sat.oz]}
              rotation={[-Math.PI / 2, 0, sat.rot]}
            >
              <circleGeometry args={[sat.size, 6]} />
              <meshStandardMaterial
                color={s.fresh ? "#cc0000" : "#7a0000"}
                roughness={0.6}
                emissive="#330000"
                emissiveIntensity={0.25}
              />
            </mesh>
          ))}
        </group>
      ))}
    </>
  );
}

// ─── Shadow Bunny (Horror Entity) ───────────────────────────────────────────

type BloodDrip = { x: number; y: number; z: number; len: number; id: number };

function ShadowBunny({
  groupRef,
  bloodDrips,
}: {
  groupRef: React.RefObject<THREE.Group | null>;
  bloodDrips: BloodDrip[];
}) {
  const pulseRef = useRef(0);
  const lightRef = useRef<THREE.PointLight>(null);
  const greenLightRef = useRef<THREE.PointLight>(null);
  const tendrilRefs = useRef<(THREE.Mesh | null)[]>([]);
  const eyeLeftRef = useRef<THREE.Mesh>(null);
  const eyeRightRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    pulseRef.current += delta * 3.5;
    const t = pulseRef.current;
    if (lightRef.current) {
      lightRef.current.intensity = 8 + Math.sin(t) * 3;
    }
    if (greenLightRef.current) {
      greenLightRef.current.intensity = 3 + Math.sin(t * 1.3 + 1.5) * 1.5;
    }
    // Pulsing eye emissive
    const eyeIntensity = 5 + Math.sin(t * 4) * 2.5;
    if (eyeLeftRef.current) {
      (
        eyeLeftRef.current.material as THREE.MeshStandardMaterial
      ).emissiveIntensity = eyeIntensity;
    }
    if (eyeRightRef.current) {
      (
        eyeRightRef.current.material as THREE.MeshStandardMaterial
      ).emissiveIntensity = eyeIntensity + Math.sin(t * 6) * 1.5;
    }
    // Writhing tendrils - sinusoidal motion
    tendrilRefs.current.forEach((mesh, i) => {
      if (!mesh) return;
      const phase = i * 0.7;
      mesh.rotation.z += Math.sin(t * 2.2 + phase) * 0.008;
      mesh.rotation.x += Math.cos(t * 1.8 + phase) * 0.006;
      mesh.scale.y = 1 + Math.sin(t * 3 + phase) * 0.12;
    });
  });

  const tendrils = [
    {
      pos: [-1.5, 1.2, 0.2] as [number, number, number],
      rot: [0.1, 0, 0.7] as [number, number, number],
      scale: [0.06, 1.4, 0.08] as [number, number, number],
    },
    {
      pos: [1.5, 1.2, 0.2] as [number, number, number],
      rot: [0.1, 0, -0.7] as [number, number, number],
      scale: [0.06, 1.4, 0.08] as [number, number, number],
    },
    {
      pos: [0, 0.3, -0.8] as [number, number, number],
      rot: [0.5, 0, 0.2] as [number, number, number],
      scale: [0.07, 1.2, 0.07] as [number, number, number],
    },
    {
      pos: [-0.8, 0.5, -0.6] as [number, number, number],
      rot: [0.4, 0.3, 0.5] as [number, number, number],
      scale: [0.05, 1.0, 0.06] as [number, number, number],
    },
    {
      pos: [0.9, 0.4, -0.5] as [number, number, number],
      rot: [0.3, -0.3, -0.5] as [number, number, number],
      scale: [0.05, 0.9, 0.06] as [number, number, number],
    },
    {
      pos: [-0.3, 0.2, -1.0] as [number, number, number],
      rot: [0.6, 0.1, -0.3] as [number, number, number],
      scale: [0.04, 1.3, 0.05] as [number, number, number],
    },
    {
      pos: [0.4, 0.1, -0.9] as [number, number, number],
      rot: [0.5, -0.2, 0.4] as [number, number, number],
      scale: [0.04, 1.1, 0.05] as [number, number, number],
    },
    // Ear tendrils
    {
      pos: [-0.55, 3.7, 0.85] as [number, number, number],
      rot: [0.5, 0.3, -0.8] as [number, number, number],
      scale: [0.04, 0.85, 0.04] as [number, number, number],
    },
    {
      pos: [0.38, 3.9, 0.88] as [number, number, number],
      rot: [0.4, -0.2, 0.6] as [number, number, number],
      scale: [0.04, 0.75, 0.04] as [number, number, number],
    },
    {
      pos: [-1.2, 0.8, -0.3] as [number, number, number],
      rot: [0.2, 0.5, 0.9] as [number, number, number],
      scale: [0.045, 1.05, 0.045] as [number, number, number],
    },
  ];

  return (
    <group ref={groupRef}>
      {/* Emaciated body — skeletal, hunched */}
      <mesh
        position={[0, 0.75, 0.3]}
        rotation={[0.5, 0, 0]}
        scale={[0.85, 0.75, 1.1]}
      >
        <sphereGeometry args={[0.9, 10, 10]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>
      {/* Stretched torso */}
      <mesh
        position={[0, 0.9, 0.7]}
        rotation={[0.6, 0, 0]}
        scale={[0.6, 0.5, 1.3]}
      >
        <sphereGeometry args={[0.75, 8, 8]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>

      {/* Rib cage — thin elongated boxes protruding */}
      {[-0.38, -0.2, 0, 0.2, 0.38].map((rx, ri) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`rib-l-${ri}`}
          position={[-0.52 + rx * 0.3, 0.75 + ri * 0.1, 0.35 + ri * 0.06]}
          rotation={[0.45, 0, 0.55 - ri * 0.1]}
          scale={[0.04, 0.5, 0.06]}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.9} />
        </mesh>
      ))}
      {[-0.38, -0.2, 0, 0.2, 0.38].map((rx, ri) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`rib-r-${ri}`}
          position={[0.52 - rx * 0.3, 0.75 + ri * 0.1, 0.35 + ri * 0.06]}
          rotation={[0.45, 0, -0.55 + ri * 0.1]}
          scale={[0.04, 0.5, 0.06]}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color="#1a1a1a" roughness={0.9} />
        </mesh>
      ))}

      {/* Spine vertebrae down the back */}
      {[0, 1, 2, 3, 4, 5].map((vi) => (
        <mesh
          key={`vert-${vi}`}
          position={[0, 0.35 + vi * 0.18, -0.18 + vi * 0.07]}
          scale={[0.09, 0.07, 0.09]}
        >
          <sphereGeometry args={[1, 5, 5]} />
          <meshStandardMaterial color="#151515" roughness={1} />
        </mesh>
      ))}

      {/* Wound / tear marks on body */}
      <mesh
        position={[0.25, 0.9, 0.85]}
        rotation={[0.6, 0.3, 0.2]}
        scale={[0.06, 0.22, 0.04]}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color="#5a0000"
          roughness={0.6}
          emissive="#3a0000"
          emissiveIntensity={1.5}
        />
      </mesh>
      <mesh
        position={[-0.15, 0.78, 0.9]}
        rotation={[0.5, -0.2, 0.5]}
        scale={[0.04, 0.18, 0.04]}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color="#5a0000"
          roughness={0.6}
          emissive="#3a0000"
          emissiveIntensity={1.5}
        />
      </mesh>

      {/* Skull-like head */}
      <mesh
        position={[0, 1.85, 1.1]}
        rotation={[0.3, 0, 0]}
        scale={[1.1, 1.25, 1]}
      >
        <sphereGeometry args={[0.72, 10, 10]} />
        <meshStandardMaterial color="#050505" roughness={0.95} />
      </mesh>
      {/* Elongated jaw */}
      <mesh
        position={[0, 1.2, 1.28]}
        rotation={[0.1, 0, 0]}
        scale={[0.82, 0.55, 0.72]}
      >
        <sphereGeometry args={[0.6, 8, 6]} />
        <meshStandardMaterial color="#080808" roughness={1} />
      </mesh>

      {/* Exposed skull patches — bone white peeking through rotting flesh */}
      <mesh position={[-0.22, 2.15, 1.42]} scale={[0.09, 0.07, 0.06]}>
        <sphereGeometry args={[1, 5, 5]} />
        <meshStandardMaterial
          color="#f0e6d0"
          roughness={0.7}
          emissive="#c8b89a"
          emissiveIntensity={0.3}
        />
      </mesh>
      <mesh position={[0.3, 2.1, 1.35]} scale={[0.08, 0.06, 0.07]}>
        <sphereGeometry args={[1, 5, 5]} />
        <meshStandardMaterial
          color="#e8d8c0"
          roughness={0.7}
          emissive="#c8b89a"
          emissiveIntensity={0.3}
        />
      </mesh>
      <mesh position={[0.05, 2.25, 1.25]} scale={[0.06, 0.05, 0.05]}>
        <sphereGeometry args={[1, 5, 5]} />
        <meshStandardMaterial
          color="#f0e6d0"
          roughness={0.7}
          emissive="#c8b89a"
          emissiveIntensity={0.2}
        />
      </mesh>

      {/* Eye sockets — deeper, larger hollow black cavities */}
      <mesh position={[-0.3, 1.97, 1.5]} scale={[1, 1, 1.3]}>
        <sphereGeometry args={[0.21, 8, 8]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>
      <mesh position={[0.26, 1.95, 1.5]} scale={[1.15, 1, 1.3]}>
        <sphereGeometry args={[0.19, 8, 8]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>

      {/* Sickly yellow-white pupils — pulsing, asymmetric */}
      <mesh ref={eyeLeftRef} position={[-0.3, 1.97, 1.62]}>
        <sphereGeometry args={[0.09, 6, 6]} />
        <meshStandardMaterial
          color="#d4c840"
          emissive="#aaaa00"
          emissiveIntensity={5}
          roughness={0}
        />
      </mesh>
      {/* Red outline ring around left eye */}
      <mesh position={[-0.3, 1.97, 1.61]} scale={[1.5, 1.5, 0.3]}>
        <torusGeometry args={[0.09, 0.025, 6, 12]} />
        <meshStandardMaterial
          color="#cc0000"
          emissive="#880000"
          emissiveIntensity={3}
          roughness={0}
        />
      </mesh>
      {/* Right eye slightly larger */}
      <mesh ref={eyeRightRef} position={[0.26, 1.95, 1.62]}>
        <sphereGeometry args={[0.11, 6, 6]} />
        <meshStandardMaterial
          color="#c8d030"
          emissive="#b0aa00"
          emissiveIntensity={5}
          roughness={0}
        />
      </mesh>
      <mesh position={[0.26, 1.95, 1.61]} scale={[1.5, 1.5, 0.3]}>
        <torusGeometry args={[0.11, 0.03, 6, 12]} />
        <meshStandardMaterial
          color="#dd0000"
          emissive="#990000"
          emissiveIntensity={3}
          roughness={0}
        />
      </mesh>

      {/* Extended jagged teeth — more, some broken/crooked */}
      {[
        { x: -0.36, h: 0.22, rot: 0.18, skip: false },
        { x: -0.26, h: 0.17, rot: -0.25, skip: false },
        { x: -0.16, h: 0.26, rot: 0.08, skip: false },
        { x: -0.07, h: 0.14, rot: 0.35, skip: false },
        { x: 0.02, h: 0.28, rot: -0.12, skip: false },
        { x: 0.11, h: 0.16, rot: 0.22, skip: false },
        { x: 0.2, h: 0.23, rot: -0.08, skip: false },
        { x: 0.3, h: 0.19, rot: 0.28, skip: false },
        { x: 0.38, h: 0.21, rot: -0.2, skip: false },
      ].map((tooth, ti) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`tooth-${ti}`}
          position={[tooth.x, 1.32, 1.44]}
          rotation={[0.15, 0, tooth.rot]}
        >
          <boxGeometry args={[0.075, tooth.h, 0.065]} />
          <meshStandardMaterial
            color={ti % 3 === 0 ? "#b8b0a0" : "#ddd8c0"}
            roughness={0.8}
          />
        </mesh>
      ))}

      {/* Hanging tongue — dark red, long, dripping */}
      <mesh
        position={[0, 1.15, 1.48]}
        rotation={[0.3, 0, 0.05]}
        scale={[0.13, 0.55, 0.1]}
      >
        <sphereGeometry args={[1, 6, 6]} />
        <meshStandardMaterial
          color="#6b0000"
          roughness={0.5}
          emissive="#3a0000"
          emissiveIntensity={1}
        />
      </mesh>
      <mesh
        position={[0.02, 0.95, 1.52]}
        rotation={[0.4, 0.05, 0.08]}
        scale={[0.09, 0.35, 0.08]}
      >
        <sphereGeometry args={[1, 5, 5]} />
        <meshStandardMaterial
          color="#6b0000"
          roughness={0.5}
          emissive="#3a0000"
          emissiveIntensity={1}
        />
      </mesh>

      {/* Blood pooling around mouth */}
      {[-0.15, 0, 0.15, -0.08, 0.08].map((bx, bi) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`mouthblood-${bi}`}
          position={[bx, 1.1 + bi * 0.04, 1.46 + bi * 0.02]}
          scale={[0.08, 0.05, 0.06]}
        >
          <sphereGeometry args={[1, 4, 4]} />
          <meshStandardMaterial
            color="#8b0000"
            roughness={0.3}
            emissive="#500000"
            emissiveIntensity={2}
          />
        </mesh>
      ))}

      {/* Long ragged ears — asymmetric */}
      <mesh
        position={[-0.35, 2.85, 1.0]}
        rotation={[0.15, 0.3, -0.22]}
        scale={[0.12, 1, 0.06]}
      >
        <boxGeometry args={[1, 1.4, 1]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>
      <mesh
        position={[-0.52, 3.65, 0.9]}
        rotation={[0.4, 0.3, -0.55]}
        scale={[0.09, 0.7, 0.05]}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#0a0000" roughness={1} />
      </mesh>
      <mesh
        position={[0.35, 3.1, 1.0]}
        rotation={[-0.05, -0.15, 0.1]}
        scale={[0.11, 1.2, 0.06]}
      >
        <boxGeometry args={[1, 1.4, 1]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>

      {/* Long bony arms */}
      <mesh
        position={[-1.15, 0.95, 0.8]}
        rotation={[0.2, 0, 0.45]}
        scale={[1, 0.75, 0.75]}
      >
        <boxGeometry args={[0.95, 0.16, 0.16]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>
      <mesh
        position={[1.15, 0.95, 0.8]}
        rotation={[0.2, 0, -0.45]}
        scale={[1, 0.75, 0.75]}
      >
        <boxGeometry args={[0.95, 0.16, 0.16]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>

      {/* Left claws — 4 thin elongated, blood-tipped */}
      {[-0.18, -0.06, 0.06, 0.18].map((cx, ci) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`claw-l-${ci}`}
          position={[-1.65 + cx * 0.25, 0.7 + ci * 0.03, 1.18]}
          rotation={[0.3, 0, 0.55]}
        >
          <boxGeometry args={[0.055, 0.55, 0.045]} />
          <meshStandardMaterial color="#0d0d0d" roughness={0.7} />
        </mesh>
      ))}
      {/* Claw blood tips */}
      {[-0.18, -0.06, 0.06, 0.18].map((cx, ci) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`claw-bl-${ci}`}
          position={[-1.78 + cx * 0.25, 0.45 + ci * 0.03, 1.3]}
          scale={[0.05, 0.08, 0.05]}
        >
          <sphereGeometry args={[1, 4, 4]} />
          <meshStandardMaterial
            color="#8b0000"
            roughness={0.3}
            emissive="#500000"
            emissiveIntensity={2}
          />
        </mesh>
      ))}
      {/* Right claws */}
      {[-0.18, -0.06, 0.06, 0.18].map((cx, ci) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`claw-r-${ci}`}
          position={[1.65 - cx * 0.25, 0.7 + ci * 0.03, 1.18]}
          rotation={[0.3, 0, -0.55]}
        >
          <boxGeometry args={[0.055, 0.55, 0.045]} />
          <meshStandardMaterial color="#0d0d0d" roughness={0.7} />
        </mesh>
      ))}
      {[-0.18, -0.06, 0.06, 0.18].map((cx, ci) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`claw-br-${ci}`}
          position={[1.78 - cx * 0.25, 0.45 + ci * 0.03, 1.3]}
          scale={[0.05, 0.08, 0.05]}
        >
          <sphereGeometry args={[1, 4, 4]} />
          <meshStandardMaterial
            color="#8b0000"
            roughness={0.3}
            emissive="#500000"
            emissiveIntensity={2}
          />
        </mesh>
      ))}

      {/* Stubby crouched legs */}
      <mesh position={[-0.42, 0.22, 0.1]}>
        <boxGeometry args={[0.3, 0.5, 0.38]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>
      <mesh position={[0.42, 0.22, 0.1]}>
        <boxGeometry args={[0.3, 0.5, 0.38]} />
        <meshStandardMaterial color="#000000" roughness={1} />
      </mesh>

      {/* Blood drips — darker crimson, varied width */}
      {bloodDrips.map((d) => (
        <mesh key={d.id} position={[d.x, d.y, d.z]}>
          <cylinderGeometry
            args={[0.04 + (d.id % 3) * 0.015, 0.01, d.len, 5]}
          />
          <meshStandardMaterial
            color="#8b0000"
            roughness={0.3}
            emissive="#500000"
            emissiveIntensity={2.5}
          />
        </mesh>
      ))}

      {/* Blood splatter discs on ground */}
      {[
        { x: 0.3, z: 0.2 },
        { x: -0.5, z: -0.1 },
        { x: 0.1, z: -0.4 },
        { x: -0.2, z: 0.5 },
        { x: 0.55, z: -0.3 },
      ].map((s, si) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`splat-${si}`}
          position={[s.x, 0.015, s.z]}
          rotation={[-Math.PI / 2, 0, si * 1.3]}
          scale={[0.25 + si * 0.04, 0.18 + si * 0.03, 1]}
        >
          <circleGeometry args={[1, 7]} />
          <meshStandardMaterial
            color="#6a0000"
            roughness={0.4}
            emissive="#3a0000"
            emissiveIntensity={1.5}
            transparent
            opacity={0.9}
          />
        </mesh>
      ))}

      {/* Shadow tendrils — animated via refs */}
      {tendrils.map((t, ti) => (
        <mesh
          // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
          key={`tendril-${ti}`}
          ref={(el) => {
            tendrilRefs.current[ti] = el;
          }}
          position={t.pos}
          rotation={t.rot}
          scale={t.scale}
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial
            color="#060000"
            roughness={1}
            transparent
            opacity={0.85}
          />
        </mesh>
      ))}

      {/* Pulsing red-orange glow — stronger */}
      <pointLight
        ref={lightRef}
        color="#ff2200"
        intensity={8}
        distance={16}
        decay={2}
        position={[0, 1.5, 0.5]}
      />
      {/* Sickly green hellish tint */}
      <pointLight
        ref={greenLightRef}
        color="#004400"
        intensity={3}
        distance={10}
        decay={2}
        position={[0, 0.5, -0.5]}
      />
      {/* Second dim offset light */}
      <pointLight
        color="#660000"
        intensity={2}
        distance={7}
        decay={2}
        position={[0, 2, 1]}
      />
    </group>
  );
}

// ─── Jumpscare Overlay ───────────────────────────────────────────────────────

function JumpscareOverlay({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<"show" | "fadeout">("show");

  useEffect(() => {
    const shakeTimer = setTimeout(() => setPhase("fadeout"), 700);
    const doneTimer = setTimeout(() => onDone(), 1200);
    return () => {
      clearTimeout(shakeTimer);
      clearTimeout(doneTimer);
    };
  }, [onDone]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        pointerEvents: "none",
        background: phase === "show" ? "rgba(0,0,0,0.95)" : "rgba(0,0,0,0)",
        transition: phase === "fadeout" ? "background 0.5s ease-out" : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        animation: phase === "show" ? "jumpscare-shake 0.07s infinite" : "none",
      }}
    >
      {/* Blood veins at screen edges */}
      {phase === "show" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at center, transparent 30%, rgba(120,0,0,0.55) 70%, rgba(180,0,0,0.85) 100%)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Blood drips from top */}
      {phase === "show" && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "100%",
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          {[5, 14, 23, 31, 42, 52, 61, 70, 79, 88].map((pct, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
              key={i}
              style={{
                position: "absolute",
                top: 0,
                left: `${pct}%`,
                width: `${3 + (i % 3) * 2}px`,
                height: `${60 + (i % 4) * 40}px`,
                background:
                  "linear-gradient(to bottom, #8b0000, #cc0000, transparent)",
                animation: `blood-drip ${0.3 + i * 0.07}s ease-in forwards`,
                borderRadius: "0 0 4px 4px",
              }}
            />
          ))}
        </div>
      )}

      {/* Horror face */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1.5rem",
          opacity: phase === "show" ? 1 : 0,
          transition: phase === "fadeout" ? "opacity 0.4s" : "none",
        }}
      >
        {/* Glowing eyes — asymmetric, complex iris */}
        <div style={{ display: "flex", gap: "5rem", marginBottom: "-1rem" }}>
          <div style={{ position: "relative", width: "6rem", height: "4rem" }}>
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                background:
                  "radial-gradient(circle at 40% 40%, #ffff44 0%, #ccaa00 25%, #ff0000 50%, #880000 70%, transparent 100%)",
                boxShadow:
                  "0 0 40px 15px #ff0000, 0 0 80px 30px #880000, inset 0 0 20px rgba(0,0,0,0.7)",
                animation: "eyepulse 0.15s infinite alternate",
                border: "2px solid #cc0000",
              }}
            />
            {/* Crack lines on left eye */}
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: 0,
                right: 0,
                height: "2px",
                background: "#660000",
                transform: "rotate(-15deg)",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: "30%",
                width: "2px",
                background: "#660000",
                transform: "rotate(10deg)",
              }}
            />
          </div>
          <div
            style={{ position: "relative", width: "7rem", height: "4.5rem" }}
          >
            <div
              style={{
                width: "100%",
                height: "100%",
                borderRadius: "50%",
                background:
                  "radial-gradient(circle at 55% 45%, #ffffff 0%, #ffff00 20%, #ff4400 45%, #cc0000 65%, transparent 100%)",
                boxShadow:
                  "0 0 50px 20px #ff2200, 0 0 100px 40px #660000, inset 0 0 25px rgba(0,0,0,0.8)",
                animation: "eyepulse 0.12s 0.04s infinite alternate",
                border: "3px solid #aa0000",
              }}
            />
          </div>
        </div>

        {/* Wound cracks on face */}
        <div
          style={{
            position: "relative",
            display: "flex",
            gap: "0.3rem",
            padding: "0.5rem 2rem",
            background: "rgba(0,0,0,0.6)",
            border: "1px solid #550000",
          }}
        >
          {/* Crack lines using CSS */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: "20%",
              bottom: 0,
              width: "1px",
              background:
                "linear-gradient(to bottom, transparent, #8b0000, transparent)",
              transform: "skew(-5deg)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 0,
              right: "30%",
              bottom: 0,
              width: "1px",
              background:
                "linear-gradient(to bottom, transparent, #660000, transparent)",
              transform: "skew(8deg)",
            }}
          />
          {/* Jagged teeth */}
          {Array.from({ length: 14 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static immutable geometry
              key={i}
              style={{
                width: "1rem",
                height:
                  i % 3 === 0 ? "4rem" : i % 2 === 0 ? "2.8rem" : "3.3rem",
                background: i % 5 === 0 ? "#c8c0a8" : "#e8e0c8",
                clipPath:
                  i % 4 === 0
                    ? "polygon(0 0, 100% 0, 70% 100%, 30% 100%)"
                    : "polygon(10% 0, 90% 0, 80% 100%, 20% 100%)",
                boxShadow: "0 0 8px rgba(255,180,180,0.4)",
                marginTop: i % 2 === 0 ? "0" : "1rem",
                transform: `rotate(${((i % 3) - 1) * 5}deg)`,
              }}
            />
          ))}
        </div>

        {/* Horror text — violent shake */}
        <div
          style={{
            fontFamily: "'Creepster', Impact, sans-serif",
            fontSize: "clamp(3rem, 10vw, 7rem)",
            color: "#dd0000",
            textShadow:
              "0 0 30px #ff0000, 0 0 60px #ff0000, 3px 3px 0 #000, -2px -2px 0 #660000",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            animation: "text-violent-shake 0.05s infinite",
          }}
        >
          I FOUND YOU
        </div>
      </div>
    </div>
  );
}

// ─── Game Scene ──────────────────────────────────────────────────────────────

interface GameSceneProps {
  treeDefs: TreeDef[];
  splatDefs: SplatDef[];
  bloodDrips: BloodDrip[];
  onGameOver: (time: number) => void;
  onDistanceChange: (dist: number) => void;
  onTimeChange: (time: number) => void;
  shakeRef: React.MutableRefObject<number>;
  onJumpscare: () => void;
  jumpscareShown: React.MutableRefObject<boolean>;
  audioRefs: React.MutableRefObject<AudioRefs>;
}

function GameScene({
  treeDefs,
  splatDefs,
  bloodDrips,
  onGameOver,
  onDistanceChange,
  onTimeChange,
  shakeRef,
  onJumpscare,
  jumpscareShown,
  audioRefs,
}: GameSceneProps) {
  const { camera, gl, scene } = useThree();

  const playerPos = useRef(new THREE.Vector3(0, 1.7, 0));
  const bunnyPos = useRef(new THREE.Vector3(0, 0, -80));
  const bunnyGroupRef = useRef<THREE.Group>(null);
  const yaw = useRef(0);
  const pitch = useRef(0);
  const keys = useRef<Record<string, boolean>>({});
  const survivalTime = useRef(0);
  const bunnySpeed = useRef(3.0);
  const isDead = useRef(false);
  const bunnyAnim = useRef(0);
  const lastHeartDist = useRef<"none" | "far" | "near" | "very-near">("none");
  const heartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    scene.fog = new THREE.FogExp2(0x080606, 0.032);
    scene.background = new THREE.Color(0x060404);
    return () => {
      scene.fog = null;
    };
  }, [scene]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement) {
        yaw.current -= e.movementX * 0.002;
        pitch.current -= e.movementY * 0.002;
        pitch.current = Math.max(-0.55, Math.min(0.55, pitch.current));
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      keys.current[e.code] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
    };
    const onClick = () => {
      gl.domElement.requestPointerLock();
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    gl.domElement.addEventListener("click", onClick);
    gl.domElement.requestPointerLock();

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      gl.domElement.removeEventListener("click", onClick);
      if (document.pointerLockElement) document.exitPointerLock();
    };
  }, [gl]);

  // Schedule repeating heartbeat
  const scheduleHeartbeat = useCallback((fast: boolean) => {
    if (heartTimer.current !== null) return;
    const beat = () => {
      if (isDead.current) return;
      const interval = playHeartbeat(fast) * 1000;
      heartTimer.current = setTimeout(beat, interval);
    };
    beat();
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartTimer.current !== null) {
      clearTimeout(heartTimer.current);
      heartTimer.current = null;
    }
  }, []);

  useFrame((_, delta) => {
    if (isDead.current) return;

    const dt = Math.min(delta, 0.05);
    survivalTime.current += dt;
    bunnySpeed.current += 0.0008 * dt;
    onTimeChange(survivalTime.current);

    // Player movement
    const sprint = keys.current.ShiftLeft || keys.current.ShiftRight;
    const speed = sprint ? 13 : 7;
    const fwd = new THREE.Vector3(
      -Math.sin(yaw.current),
      0,
      -Math.cos(yaw.current),
    );
    const right = new THREE.Vector3(
      Math.cos(yaw.current),
      0,
      -Math.sin(yaw.current),
    );

    const moving =
      keys.current.KeyW ||
      keys.current.ArrowUp ||
      keys.current.KeyS ||
      keys.current.ArrowDown ||
      keys.current.KeyA ||
      keys.current.ArrowLeft ||
      keys.current.KeyD ||
      keys.current.ArrowRight;

    if (keys.current.KeyW || keys.current.ArrowUp)
      playerPos.current.addScaledVector(fwd, speed * dt);
    if (keys.current.KeyS || keys.current.ArrowDown)
      playerPos.current.addScaledVector(fwd, -speed * dt * 0.55);
    if (keys.current.KeyA || keys.current.ArrowLeft)
      playerPos.current.addScaledVector(right, -speed * dt);
    if (keys.current.KeyD || keys.current.ArrowRight)
      playerPos.current.addScaledVector(right, speed * dt);

    playerPos.current.x = Math.max(-190, Math.min(190, playerPos.current.x));
    playerPos.current.z = Math.max(-190, Math.min(190, playerPos.current.z));

    // Bunny chase
    const bp = bunnyPos.current;
    const toPlayer = new THREE.Vector3(
      playerPos.current.x - bp.x,
      0,
      playerPos.current.z - bp.z,
    );
    const dist = toPlayer.length();
    if (dist > 0.01) {
      toPlayer.normalize();
      bp.addScaledVector(toPlayer, bunnySpeed.current * dt);
    }

    // Bunny bob
    bunnyAnim.current += dt * 5.5;
    if (bunnyGroupRef.current) {
      bunnyGroupRef.current.position.set(
        bp.x,
        Math.abs(Math.sin(bunnyAnim.current)) * 0.25,
        bp.z,
      );
      bunnyGroupRef.current.lookAt(
        playerPos.current.x,
        bunnyGroupRef.current.position.y,
        playerPos.current.z,
      );
    }

    // Audio: heartbeat zone
    const newHeartDist = dist < 15 ? "very-near" : dist < 35 ? "near" : "none";
    if (newHeartDist !== lastHeartDist.current) {
      lastHeartDist.current = newHeartDist;
      clearHeartbeat();
      if (newHeartDist === "near") scheduleHeartbeat(false);
      else if (newHeartDist === "very-near") scheduleHeartbeat(true);
    }

    // Footstep thumps while running
    if (moving && audioRefs.current.footstepInterval === null) {
      audioRefs.current.footstepInterval = setInterval(playFootstep, 800);
    } else if (!moving && audioRefs.current.footstepInterval !== null) {
      clearInterval(audioRefs.current.footstepInterval);
      audioRefs.current.footstepInterval = null;
    }

    // Jumpscare trigger
    if (dist < 8 && !jumpscareShown.current) {
      jumpscareShown.current = true;
      onJumpscare();
    }

    // Screen shake — much more violent close up
    const shakeMult = dist < 8 ? 3 : 1;
    shakeRef.current = dist < 22 ? ((22 - dist) / 22) * 0.18 * shakeMult : 0;

    // Camera
    const shake = shakeRef.current;
    const sx = shake > 0 ? (Math.random() - 0.5) * shake : 0;
    const sy = shake > 0 ? (Math.random() - 0.5) * shake * 0.4 : 0;
    const sz = shake > 0 ? (Math.random() - 0.5) * shake : 0;
    camera.position.set(
      playerPos.current.x + sx,
      1.7 + sy,
      playerPos.current.z + sz,
    );
    camera.rotation.order = "YXZ";
    camera.rotation.y = yaw.current;
    camera.rotation.x = pitch.current;

    onDistanceChange(dist);

    if (dist < 3.2) {
      isDead.current = true;
      clearHeartbeat();
      if (document.pointerLockElement) document.exitPointerLock();
      onGameOver(survivalTime.current);
    }
  });

  return (
    <>
      <ambientLight intensity={0.03} color="#200606" />
      <pointLight
        position={[0, 2.5, 0]}
        intensity={10}
        color="#ff1800"
        distance={28}
        decay={2}
      />
      {/* Ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[400, 400, 1, 1]} />
        <meshStandardMaterial color="#060906" roughness={1} />
      </mesh>
      <Trees defs={treeDefs} />
      <BloodSplatters defs={splatDefs} />
      <ShadowBunny groupRef={bunnyGroupRef} bloodDrips={bloodDrips} />
    </>
  );
}

// ─── Menu Background Scene ───────────────────────────────────────────────────

function MenuScene({
  treeDefs,
  splatDefs,
}: { treeDefs: TreeDef[]; splatDefs: SplatDef[] }) {
  const { scene, camera } = useThree();
  const t = useRef(0);

  useEffect(() => {
    scene.fog = new THREE.FogExp2(0x060404, 0.038);
    scene.background = new THREE.Color(0x060404);
    camera.position.set(0, 1.7, 0);
    camera.rotation.order = "YXZ";
    return () => {
      scene.fog = null;
    };
  }, [scene, camera]);

  useFrame((_, delta) => {
    t.current += delta * 0.08;
    camera.rotation.y = Math.sin(t.current) * 0.25;
    camera.rotation.x = Math.sin(t.current * 0.7) * 0.04;
  });

  return (
    <>
      <ambientLight intensity={0.025} />
      <pointLight
        position={[0, 3, 0]}
        intensity={5}
        color="#aa1100"
        distance={22}
        decay={2}
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[400, 400, 1, 1]} />
        <meshStandardMaterial color="#060906" roughness={1} />
      </mesh>
      <Trees defs={treeDefs} />
      <BloodSplatters defs={splatDefs} />
    </>
  );
}

// ─── Shared styles ───────────────────────────────────────────────────────────

const horrorFont = "'Creepster', Impact, 'Arial Black', sans-serif";

const btnBase: React.CSSProperties = {
  fontFamily: horrorFont,
  letterSpacing: "0.15em",
  textTransform: "uppercase",
  cursor: "pointer",
  border: "none",
  transition: "background 0.2s, border-color 0.2s, color 0.2s",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.75rem 1rem",
  background: "rgba(8,8,8,0.95)",
  border: "1px solid #7a1717",
  color: "#f2f4f3",
  fontFamily: "sans-serif",
  fontSize: "1rem",
  letterSpacing: "0.1em",
  outline: "none",
  textTransform: "uppercase",
  boxSizing: "border-box",
};

// ─── Main App ────────────────────────────────────────────────────────────────

export default function App() {
  const [gameState, setGameState] = useState<GameState>("menu");
  const [playerName, setPlayerName] = useState("");
  const [survivalTime, setSurvivalTime] = useState(0);
  const [distance, setDistance] = useState(80);
  const [leaderboard, setLeaderboard] = useState<ScoreEntry[]>([]);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitName, setSubmitName] = useState("");
  const [gameKey, setGameKey] = useState(0);
  const [jumpscareActive, setJumpscareActive] = useState(false);
  const shakeRef = useRef(0);
  const jumpscareShown = useRef(false);
  const audioRefs = useRef<AudioRefs>({
    drone1: null,
    drone2: null,
    droneGain: null,
    droneGain2: null,
    sawOsc: null,
    sawGain: null,
    lfo: null,
    heartbeatInterval: null,
    footstepInterval: null,
  });
  const { actor } = useActor();

  const treeDefs = useMemo<TreeDef[]>(() => {
    const arr: TreeDef[] = [];
    const rng = mulberry32(42);
    for (let i = 0; i < 260; i++) {
      const x = (rng() - 0.5) * 380;
      const z = (rng() - 0.5) * 380;
      if (Math.abs(x) < 10 && Math.abs(z) < 10) continue;
      arr.push({
        x,
        z,
        height: 12 + rng() * 10,
        trunkR: 0.28 + rng() * 0.28,
        id: i,
      });
    }
    return arr;
  }, []);

  const splatDefs = useMemo<SplatDef[]>(() => {
    const arr: SplatDef[] = [];
    const rng = mulberry32(99);
    for (let i = 0; i < 150; i++) {
      const numSats = 3 + Math.floor(rng() * 4);
      const sats: SplatDef["satellites"] = [];
      for (let j = 0; j < numSats; j++) {
        const angle = rng() * Math.PI * 2;
        const dist2 = 0.4 + rng() * 1.2;
        sats.push({
          ox: Math.cos(angle) * dist2,
          oz: Math.sin(angle) * dist2,
          size: 0.1 + rng() * 0.35,
          rot: rng() * Math.PI,
        });
      }
      arr.push({
        x: (rng() - 0.5) * 350,
        z: (rng() - 0.5) * 350,
        size: 0.3 + rng() * 1.4,
        rot: rng() * Math.PI,
        id: i,
        fresh: i % 3 === 0,
        scaleX: 0.6 + rng() * 0.8,
        scaleZ: 0.6 + rng() * 0.8,
        satellites: sats,
      });
    }
    return arr;
  }, []);

  const bloodDrips = useMemo<BloodDrip[]>(() => {
    const arr: BloodDrip[] = [];
    const rng = mulberry32(55);
    // belly drips
    for (let i = 0; i < 6; i++) {
      arr.push({
        x: (rng() - 0.5) * 1.4,
        y: 0.4 - rng() * 0.35,
        z: 0.2 + rng() * 0.6,
        len: 0.2 + rng() * 0.55,
        id: i,
      });
    }
    // chin drips
    for (let i = 6; i < 10; i++) {
      arr.push({
        x: (rng() - 0.5) * 0.6,
        y: 1.2 - rng() * 0.2,
        z: 1.3 + rng() * 0.2,
        len: 0.15 + rng() * 0.3,
        id: i,
      });
    }
    // arm drips
    for (let i = 10; i < 14; i++) {
      arr.push({
        x: (rng() > 0.5 ? 1 : -1) * (0.8 + rng() * 0.5),
        y: 0.8 - rng() * 0.3,
        z: 0.4 + rng() * 0.5,
        len: 0.1 + rng() * 0.3,
        id: i,
      });
    }
    return arr;
  }, []);

  const vignetteOpacity = Math.max(
    0,
    Math.min(0.88, ((80 - distance) / 80) * 0.88),
  );
  const warningVisible = distance < 42 && gameState === "playing";

  const fetchLeaderboard = useCallback(async () => {
    setLoadingBoard(true);
    try {
      const scores = await actor!.getTopScores();
      setLeaderboard(
        [...scores].sort((a, b) => b.survivalTime - a.survivalTime),
      );
    } catch (e) {
      console.error(e);
    }
    setLoadingBoard(false);
  }, [actor]);

  const handleGameOver = useCallback(
    (time: number) => {
      stopAmbientDrone(audioRefs.current);
      setSurvivalTime(time);
      setSubmitName(playerName);
      setGameState("gameover");
    },
    [playerName],
  );

  const handleJumpscare = useCallback(() => {
    setJumpscareActive(true);
    playScream();
  }, []);

  const startGame = useCallback(
    (name?: string) => {
      const n = name ?? playerName;
      if (!n.trim()) return;
      setPlayerName(n.trim());
      setDistance(80);
      setSurvivalTime(0);
      setJumpscareActive(false);
      jumpscareShown.current = false;
      setGameKey((k) => k + 1);
      // Start ambient drone
      stopAmbientDrone(audioRefs.current);
      setTimeout(() => startAmbientDrone(audioRefs.current), 50);
      setGameState("playing");
    },
    [playerName],
  );

  const handleSubmitScore = useCallback(async () => {
    const name = submitName.trim() || "UNKNOWN";
    setSubmitting(true);
    try {
      await actor!.submitScore(name, Math.floor(survivalTime));
    } catch (e) {
      console.error(e);
    }
    setSubmitting(false);
    await fetchLeaderboard();
    setGameState("leaderboard");
  }, [actor, submitName, survivalTime, fetchLeaderboard]);

  const handleShowLeaderboard = useCallback(() => {
    fetchLeaderboard();
    setGameState("leaderboard");
  }, [fetchLeaderboard]);

  const showCanvas = gameState === "menu" || gameState === "playing";

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#060404",
        position: "relative",
        fontFamily: horrorFont,
      }}
    >
      {/* CSS animations */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Creepster&display=swap');
        @keyframes flicker {
          0%,100%{opacity:1} 92%{opacity:1} 93%{opacity:0.4} 94%{opacity:1} 96%{opacity:0.6} 97%{opacity:1}
        }
        @keyframes pulse-warning {
          0%,100%{opacity:1;text-shadow:0 0 10px #ff0000,0 0 20px #aa0000}
          50%{opacity:0.6;text-shadow:0 0 4px #ff0000}
        }
        @keyframes jumpscare-shake {
          0%{transform:translate(0,0)}
          20%{transform:translate(-18px,12px)}
          40%{transform:translate(16px,-10px)}
          60%{transform:translate(-12px,16px)}
          80%{transform:translate(14px,-14px)}
          100%{transform:translate(0,0)}
        }
        @keyframes eyepulse {
          0%{box-shadow:0 0 40px 15px #ff0000,0 0 80px 30px #880000;transform:scale(1)}
          100%{box-shadow:0 0 60px 25px #ff2200,0 0 120px 50px #660000;transform:scale(1.12)}
        }
        @keyframes text-violent-shake {
          0%{transform:translate(0,0) rotate(0deg)}
          15%{transform:translate(-12px,8px) rotate(-3deg)}
          30%{transform:translate(10px,-9px) rotate(2deg)}
          45%{transform:translate(-8px,11px) rotate(-2.5deg)}
          60%{transform:translate(14px,-7px) rotate(3deg)}
          75%{transform:translate(-11px,6px) rotate(-1.5deg)}
          100%{transform:translate(0,0) rotate(0deg)}
        }
        @keyframes blood-drip {
          0%{height:0;opacity:0.9}
          100%{height:160px;opacity:1}
        }
      `}</style>

      {/* 3D Canvas */}
      {showCanvas && (
        <Canvas
          key={gameKey}
          style={{ position: "absolute", inset: 0 }}
          camera={{ fov: 75, near: 0.1, far: 280 }}
          gl={{ antialias: false }}
          dpr={[1, 1.5]}
        >
          {gameState === "playing" && (
            <GameScene
              treeDefs={treeDefs}
              splatDefs={splatDefs}
              bloodDrips={bloodDrips}
              onGameOver={handleGameOver}
              onDistanceChange={setDistance}
              onTimeChange={setSurvivalTime}
              shakeRef={shakeRef}
              onJumpscare={handleJumpscare}
              jumpscareShown={jumpscareShown}
              audioRefs={audioRefs}
            />
          )}
          {gameState === "menu" && (
            <MenuScene treeDefs={treeDefs} splatDefs={splatDefs} />
          )}
        </Canvas>
      )}

      {/* Jumpscare overlay */}
      {jumpscareActive && (
        <JumpscareOverlay onDone={() => setJumpscareActive(false)} />
      )}

      {/* Blood vignette */}
      {gameState === "playing" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `radial-gradient(ellipse at center, transparent 25%, rgba(110,0,0,${vignetteOpacity}) 100%)`,
          }}
        />
      )}

      {/* HUD */}
      {gameState === "playing" && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              textAlign: "center",
              paddingTop: "1.2rem",
              fontFamily: horrorFont,
              fontSize: "2.4rem",
              color: "#f2f4f3",
              textShadow: "0 0 12px #cc0000, 0 0 24px #880000",
            }}
          >
            {formatTime(survivalTime)}
          </div>
          {warningVisible && (
            <div
              style={{
                textAlign: "center",
                marginTop: "0.4rem",
                fontFamily: horrorFont,
                fontSize: "1.15rem",
                color: "#ff0000",
                textShadow: "0 0 10px #ff0000, 0 0 20px #aa0000",
                animation: "pulse-warning 0.45s infinite",
                letterSpacing: "0.25em",
              }}
            >
              {distance < 15
                ? "⚠ IT'S RIGHT BEHIND YOU ⚠"
                : "IT'S GETTING CLOSER..."}
            </div>
          )}
          <div
            style={{
              textAlign: "center",
              marginTop: "0.4rem",
              fontFamily: "sans-serif",
              fontSize: "0.72rem",
              color: "rgba(242,244,243,0.35)",
              letterSpacing: "0.12em",
            }}
          >
            WASD · MOUSE LOOK · SHIFT SPRINT · CLICK CANVAS TO LOCK MOUSE
          </div>
        </div>
      )}

      {/* ── MAIN MENU ── */}
      {gameState === "menu" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(4,2,2,0.72)",
          }}
        >
          <div
            style={{
              fontFamily: horrorFont,
              fontSize: "clamp(3rem,11vw,7.5rem)",
              color: "#cc0000",
              textShadow:
                "0 0 30px #ff0000, 0 0 60px #880000, 3px 3px 0 #000, -1px -1px 0 #000",
              letterSpacing: "0.06em",
              textAlign: "center",
              lineHeight: 1,
              marginBottom: "0.4rem",
              animation: "flicker 3s infinite",
            }}
          >
            RUN FROM
            <br />
            BUNNEY
          </div>
          <div
            style={{
              fontFamily: horrorFont,
              fontSize: "1.15rem",
              color: "#f2f4f3",
              letterSpacing: "0.45em",
              marginBottom: "3rem",
              textShadow: "0 0 8px #cc0000",
              opacity: 0.75,
            }}
          >
            IT WILL FIND YOU
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.9rem",
              width: "min(340px,90vw)",
            }}
          >
            <input
              data-ocid="menu.input"
              type="text"
              placeholder="ENTER YOUR NAME..."
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startGame()}
              maxLength={20}
              style={inputStyle}
            />
            <button
              type="button"
              data-ocid="menu.primary_button"
              onClick={() => startGame()}
              disabled={!playerName.trim()}
              style={{
                ...btnBase,
                width: "100%",
                padding: "0.95rem",
                background: playerName.trim() ? "#8b0000" : "#3a1a1a",
                color: "#f2f4f3",
                fontSize: "1.55rem",
                cursor: playerName.trim() ? "pointer" : "not-allowed",
              }}
              onMouseEnter={(e) => {
                if (playerName.trim())
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "#cc0000";
              }}
              onMouseLeave={(e) => {
                if (playerName.trim())
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "#8b0000";
              }}
            >
              START RUNNING
            </button>
            <button
              type="button"
              data-ocid="menu.secondary_button"
              onClick={handleShowLeaderboard}
              style={{
                ...btnBase,
                width: "100%",
                padding: "0.7rem",
                background: "transparent",
                color: "#f2f4f3",
                border: "1px solid #3a4742",
                fontSize: "1.2rem",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  "#7a1717";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  "#3a4742";
              }}
            >
              LEADERBOARD
            </button>
          </div>

          <div
            style={{
              marginTop: "2.5rem",
              width: "min(340px,90vw)",
              height: "2px",
              background:
                "linear-gradient(90deg, transparent, #7a1717, transparent)",
            }}
          />
          <div
            style={{
              marginTop: "0.8rem",
              fontFamily: "sans-serif",
              fontSize: "0.7rem",
              color: "rgba(242,244,243,0.25)",
              letterSpacing: "0.1em",
            }}
          >
            HOW LONG CAN YOU SURVIVE?
          </div>
        </div>
      )}

      {/* ── GAME OVER ── */}
      {gameState === "gameover" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(4,0,0,0.93)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontFamily: horrorFont,
              fontSize: "clamp(2.2rem,8vw,5rem)",
              color: "#cc0000",
              textShadow: "0 0 20px #ff0000, 0 0 40px #880000",
              textAlign: "center",
              marginBottom: "0.3rem",
              animation: "flicker 2s infinite",
            }}
          >
            YOU WERE CAUGHT
          </div>
          <div
            style={{
              fontFamily: horrorFont,
              fontSize: "1.9rem",
              color: "#f2f4f3",
              textShadow: "0 0 8px #cc0000",
              marginBottom: "2.8rem",
              letterSpacing: "0.08em",
            }}
          >
            SURVIVED: {formatTime(survivalTime)}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.85rem",
              width: "min(320px,90vw)",
            }}
          >
            <input
              data-ocid="gameover.input"
              type="text"
              placeholder="YOUR NAME..."
              value={submitName}
              onChange={(e) => setSubmitName(e.target.value)}
              maxLength={20}
              style={inputStyle}
            />
            <button
              type="button"
              data-ocid="gameover.submit_button"
              onClick={handleSubmitScore}
              disabled={submitting || !submitName.trim()}
              style={{
                ...btnBase,
                padding: "0.9rem",
                background: submitting ? "#4a0000" : "#8b0000",
                color: "#f2f4f3",
                fontSize: "1.4rem",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? "SUBMITTING..." : "SUBMIT SCORE"}
            </button>
            <button
              type="button"
              data-ocid="gameover.primary_button"
              onClick={() => startGame(submitName)}
              style={{
                ...btnBase,
                padding: "0.75rem",
                background: "transparent",
                color: "#f2f4f3",
                border: "1px solid #7a1717",
                fontSize: "1.25rem",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "rgba(122,23,23,0.3)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
              }}
            >
              RUN AGAIN
            </button>
            <button
              type="button"
              data-ocid="gameover.secondary_button"
              onClick={handleShowLeaderboard}
              style={{
                ...btnBase,
                padding: "0.7rem",
                background: "transparent",
                color: "rgba(242,244,243,0.55)",
                border: "1px solid #3a4742",
                fontSize: "1.1rem",
              }}
            >
              LEADERBOARD
            </button>
          </div>
        </div>
      )}

      {/* ── LEADERBOARD ── */}
      {gameState === "leaderboard" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "#0b0f0d",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "2.5rem 1rem 1.5rem",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              fontFamily: horrorFont,
              fontSize: "clamp(1.8rem,7vw,4rem)",
              color: "#cc0000",
              textShadow: "0 0 20px #ff0000",
              marginBottom: "0.2rem",
              letterSpacing: "0.08em",
              animation: "flicker 4s infinite",
            }}
          >
            SURVIVORS BOARD
          </div>
          <div
            style={{
              color: "rgba(242,244,243,0.35)",
              fontFamily: "sans-serif",
              fontSize: "0.75rem",
              letterSpacing: "0.2em",
              marginBottom: "2rem",
              textTransform: "uppercase",
            }}
          >
            Those Who Lasted The Longest
          </div>

          <div style={{ width: "min(680px,100%)", flex: 1 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "56px 1fr 110px 130px",
                padding: "0.55rem 1rem",
                borderBottom: "1px solid #7a1717",
                color: "#7a1717",
                fontFamily: "sans-serif",
                fontSize: "0.72rem",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
              }}
            >
              <span>RANK</span>
              <span>PLAYER</span>
              <span style={{ textAlign: "right" }}>TIME</span>
              <span style={{ textAlign: "right" }}>DATE</span>
            </div>

            {loadingBoard && (
              <div
                data-ocid="leaderboard.loading_state"
                style={{
                  padding: "2rem",
                  textAlign: "center",
                  color: "#cc0000",
                  fontFamily: horrorFont,
                  fontSize: "1.5rem",
                  letterSpacing: "0.15em",
                }}
              >
                LOADING...
              </div>
            )}

            {!loadingBoard && leaderboard.length === 0 && (
              <div
                data-ocid="leaderboard.empty_state"
                style={{
                  padding: "2.5rem",
                  textAlign: "center",
                  color: "rgba(242,244,243,0.3)",
                  fontFamily: "sans-serif",
                  letterSpacing: "0.1em",
                }}
              >
                No survivors yet. Be the first!
              </div>
            )}

            {leaderboard.map((entry, i) => (
              <div
                key={`${entry.playerName}-${String(entry.timestamp)}-${i}`}
                data-ocid={`leaderboard.item.${i + 1}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "56px 1fr 110px 130px",
                  padding: "0.8rem 1rem",
                  borderBottom: "1px solid rgba(58,71,66,0.3)",
                  color: i === 0 ? "#cc0000" : "#f2f4f3",
                  fontFamily: i === 0 ? horrorFont : "sans-serif",
                  fontSize: i === 0 ? "1.1rem" : "0.88rem",
                  background: i === 0 ? "rgba(122,23,23,0.18)" : "transparent",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    color:
                      i === 0
                        ? "#cc0000"
                        : i === 1
                          ? "#aa6622"
                          : i === 2
                            ? "#887755"
                            : "rgba(242,244,243,0.35)",
                    fontFamily: horrorFont,
                    fontSize: "1rem",
                  }}
                >
                  #{i + 1}
                </span>
                <span>{entry.playerName}</span>
                <span
                  style={{
                    textAlign: "right",
                    fontFamily: "monospace",
                    letterSpacing: "0.05em",
                  }}
                >
                  {formatTime(entry.survivalTime)}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: "rgba(242,244,243,0.35)",
                    fontSize: "0.78rem",
                    fontFamily: "sans-serif",
                  }}
                >
                  {new Date(
                    Number(entry.timestamp) / 1_000_000,
                  ).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: "2rem",
              display: "flex",
              gap: "1rem",
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              data-ocid="leaderboard.cancel_button"
              onClick={() => setGameState("menu")}
              style={{
                ...btnBase,
                padding: "0.7rem 2rem",
                background: "transparent",
                color: "#f2f4f3",
                border: "1px solid #3a4742",
                fontSize: "1.15rem",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  "#7a1717";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor =
                  "#3a4742";
              }}
            >
              BACK
            </button>
            <button
              type="button"
              data-ocid="leaderboard.primary_button"
              onClick={() => setGameState("menu")}
              style={{
                ...btnBase,
                padding: "0.7rem 2rem",
                background: "#8b0000",
                color: "#f2f4f3",
                fontSize: "1.15rem",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "#cc0000";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "#8b0000";
              }}
            >
              PLAY AGAIN
            </button>
          </div>

          <footer
            style={{
              marginTop: "2rem",
              color: "rgba(242,244,243,0.2)",
              fontSize: "0.72rem",
              fontFamily: "sans-serif",
              textAlign: "center",
            }}
          >
            © {new Date().getFullYear()}. Built with ❤ using{" "}
            <a
              href={`https://caffeine.ai?utm_source=caffeine-footer&utm_medium=referral&utm_content=${encodeURIComponent(window.location.hostname)}`}
              target="_blank"
              rel="noreferrer"
              style={{
                color: "rgba(242,244,243,0.35)",
                textDecoration: "underline",
              }}
            >
              caffeine.ai
            </a>
          </footer>
        </div>
      )}
    </div>
  );
}
