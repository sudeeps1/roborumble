// Upgrades the GLB's materials (matched by name) to semi-realistic MeshPhysicalMaterials.
// Base colour always comes from COLOR_0 (linear, AO and variation baked in); colour factors stay white.
//
// Shader patches (onBeforeCompile), checked against three r186 chunk text:
//   - surface detail without UVs: triplanar in BIND-POSE object space (position/normal before skinning,
//     passed as varyings), so the texture sticks to the skin. A macro layer (wrinkles, blotches, 5-20 mm)
//     plus a per-family micro layer (pores, grain, weave, hammer dents; faded out by pixel footprint).
//     The object-space normal offset is carried to view space with the per-vertex skinning rotation.
//     Each texture drives normal, albedo and roughness (detail.ts). Convex curvature (`_curv`) adds edge wear.
//   - skin + lips: per-channel wrap diffuse (red scatters furthest), wider on high curvature, dual-lobe
//     specular, backlit translucency on thin shells (`_thin`: ears, fingers)
//   - hair: Kajiya-Kay with a shifted primary and a hair-tinted secondary lobe along the skinned `_flow`
//     strand direction, strand-level jitter, bent-normal IBL. Without `_flow`: sheen look.
//   - hair_card: alpha cutout (alphaToCoverage on the MSAA target, alphaTest fallback), double sided
//   - eyes: darker limbal ring, sclera shading toward the lids, wet clearcoat cornea
//   - every material: hit-flash rim, bloom mask in alpha (alpha = 1 + mask; the viewer's bloom reads it)
//   - team hue shift (uHue) on cloth / runes / gem after <color_fragment>
import * as THREE from "three";
import { detailTextures, TILE, type MicroKind } from "./detail.ts";
import { ensureCurvature, ensureThickness, ensureFlow, ensureZeroFlow, synthFlow } from "./geomprep.ts";

export interface CharacterUniforms {
  flash: { value: number };
  flashColor: { value: THREE.Color };
  hue: { value: number };
}

export interface MaterialSet {
  all: THREE.MeshPhysicalMaterial[];
  /** Emissive materials driven by setGlow: base intensity and how much glow adds. */
  glow: { mat: THREE.MeshPhysicalMaterial; base: number; gain: number }[];
  uniforms: CharacterUniforms;
}

/** Global render-quality switches shared by every elf material. */
export const elfQuality = {
  micro: { value: 1 },      // micro detail layer (pores, weave, grain)
  alphaToCoverage: true,     // hair cards: A2C on an MSAA target, else alphaTest only
};
const cardMats = new Set<THREE.MeshPhysicalMaterial>();

/** "high": micro detail + A2C hair cards. "low": macro detail only, alphaTest hair cards. */
export function setElfQuality(q: "high" | "low", msaa = true) {
  elfQuality.micro.value = q === "high" ? 1 : 0;
  elfQuality.alphaToCoverage = q === "high" && msaa;
  for (const m of cardMats) {
    if (m.alphaToCoverage !== elfQuality.alphaToCoverage) { m.alphaToCoverage = elfQuality.alphaToCoverage; m.needsUpdate = true; }
  }
}

const HUE_MATS = new Set(["tunic", "wrap", "leather_green", "rune", "gem"]);
const HAIR_MATS = new Set(["hair", "brow", "hair_card"]);

type Kind = "skin" | "hair" | "eye" | "card" | "plain";
interface Detail {
  micro?: MicroKind;
  /** micro: normal strength, albedo amount, roughness amount */
  mi?: [number, number, number];
  /** macro: normal strength, albedo amount, roughness amount */
  ma: [number, number, number];
  /** convex edge wear: curvature where it starts (1/m), albedo gain, roughness delta */
  edge?: [number, number, number];
}
interface Look { params: Partial<THREE.MeshPhysicalMaterialParameters>; kind?: Kind; detail?: Detail }

const c = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const LOOKS: Record<string, Look> = {
  skin: {
    kind: "skin",
    params: { roughness: 0.5, ior: 1.4, specularIntensity: 0.85, sheen: 0.12, sheenRoughness: 0.5, sheenColor: c(0.42, 0.3, 0.26) },
    detail: { micro: "skin", mi: [1.1, 0.25, 0.22], ma: [0.2, 0.14, 0.18] },
  },
  lips: {
    kind: "skin",
    params: { roughness: 0.3, ior: 1.4, specularIntensity: 1, clearcoat: 0.35, clearcoatRoughness: 0.24, sheen: 0.1, sheenRoughness: 0.4, sheenColor: c(0.4, 0.25, 0.25) },
    detail: { micro: "lips", mi: [0.7, 0.3, 0.25], ma: [0.05, 0.08, 0.1] },
  },
  hair: { kind: "hair", params: { roughness: 0.4, specularIntensity: 0.55 }, detail: { ma: [0.0, 0.14, 0.1] } },
  hair_card: { kind: "card", params: { roughness: 0.42, specularIntensity: 0.5 } },
  brow: { kind: "hair", params: { roughness: 0.6, specularIntensity: 0.3, sheen: 0.5, sheenRoughness: 0.5, sheenColor: c(0.4, 0.45, 0.55) } },
  lash: { params: { roughness: 0.75, specularIntensity: 0.2 } },
  tunic: {
    params: { roughness: 0.84, specularIntensity: 0.3, sheen: 1, sheenRoughness: 0.5, sheenColor: c(0.25, 0.55, 0.38) },
    detail: { micro: "twill", mi: [0.9, 0.35, 0.2], ma: [0.35, 0.14, 0.1], edge: [140, 0.1, 0.05] },
  },
  legging: {
    params: { roughness: 0.82, specularIntensity: 0.3, sheen: 0.7, sheenRoughness: 0.5, sheenColor: c(0.22, 0.25, 0.36) },
    detail: { micro: "knit", mi: [0.9, 0.35, 0.15], ma: [0.3, 0.12, 0.08] },
  },
  wrap: {
    params: { roughness: 0.92, specularIntensity: 0.2, sheen: 0.8, sheenRoughness: 0.7, sheenColor: c(0.7, 0.62, 0.45) },
    detail: { micro: "linen", mi: [1.0, 0.45, 0.12], ma: [0.3, 0.2, 0.08] },
  },
  leather: {
    params: { roughness: 0.58, specularIntensity: 0.55 },
    detail: { micro: "leather", mi: [0.8, 0.35, 0.35], ma: [0.45, 0.2, 0.25], edge: [90, 0.4, 0.15] },
  },
  leather_dark: {
    params: { roughness: 0.52, specularIntensity: 0.55 },
    detail: { micro: "leather", mi: [0.8, 0.35, 0.35], ma: [0.45, 0.2, 0.25], edge: [90, 0.5, 0.15] },
  },
  leather_green: {
    params: { roughness: 0.5, specularIntensity: 0.55 },
    detail: { micro: "leather", mi: [0.75, 0.3, 0.3], ma: [0.4, 0.18, 0.22], edge: [90, 0.4, 0.12] },
  },
  boot: {
    params: { roughness: 0.55, specularIntensity: 0.55 },
    detail: { micro: "boot", mi: [0.75, 0.35, 0.35], ma: [0.45, 0.2, 0.25], edge: [90, 0.4, 0.12] },
  },
  gold: {
    params: { metalness: 1, roughness: 0.3, envMapIntensity: 1.15 },
    detail: { micro: "gold", mi: [0.35, 0.12, 0.3], ma: [0.2, 0.12, 0.2], edge: [110, 0.18, -0.12] },
  },
  gem: { params: { roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.8, specularIntensity: 1, iridescence: 0.25, iridescenceIOR: 1.5 } },
  rune: { params: { roughness: 0.35, metalness: 0, specularIntensity: 0.4 } },
  mouth: { params: { roughness: 0.6, specularIntensity: 0.2 } },
  eye: { kind: "eye", params: { roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03, specularIntensity: 0.6 } },
};

// emissive base intensity and setGlow gain (charging pulse)
const GLOW: Record<string, { base: number; gain: number }> = {
  rune: { base: 0.55, gain: 5.5 },
  gem: { base: 1.6, gain: 6.0 },
};

// hair shading: primary (shifted toward the root, white) and secondary (toward the tip, hair-tinted)
const HAIR = { kk: new THREE.Vector4(-0.08, 0.12, 180, 36), spec1: c(0.2, 0.2, 0.22), spec2: 0.55, center: new THREE.Vector3(0.0, 1.2, 0.0) };
const SKIN_TRANS = c(1.0, 0.32, 0.16).multiplyScalar(1.1);

const DIRECT_FN = /void RE_Direct_Physical\([^)]*\)\s*\{/;
const DIRECT_DIFFUSE_LINE = "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );";
const DIRECT_SPEC_LINE = "vec3 specularBRDF = BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );";
const IBL_LINE = "vec3 iblRadiance = getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );";
let warned = false;
const warnOnce = (what: string) => { if (!warned) { warned = true; console.warn(`[materials] three's shader chunks changed (${what}); some elf shading is disabled`); } };

interface Facts { color: boolean; flow: boolean; mats: number }

/** Replace every mesh material under `root` with an upgraded per-instance material. */
export function upgradeMaterials(root: THREE.Object3D, opts: { hue?: number } = {}): MaterialSet {
  const uniforms: CharacterUniforms = {
    flash: { value: 0 },
    flashColor: { value: new THREE.Color(1.0, 0.55, 0.4) },
    hue: { value: opts.hue ?? 0 },
  };
  const byName = new Map<string, THREE.MeshPhysicalMaterial>();
  const set: MaterialSet = { all: [], glow: [], uniforms };
  const tex = detailTextures();

  // per material name: does every mesh have vertex colours, does any carry strand flow
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const facts = new Map<string, Facts>();
  const matsOf = (m: THREE.Mesh) => (Array.isArray(m.material) ? m.material : [m.material]);
  const fakeFlow = typeof location !== "undefined" && new URLSearchParams(location.search).has("fakeflow");
  for (const mesh of meshes) {
    const g = mesh.geometry;
    ensureCurvature(g);
    for (const mat of matsOf(mesh)) {
      const name = mat.name || "default";
      const f = facts.get(name) ?? { color: true, flow: false, mats: 0 };
      f.color &&= !!g.getAttribute("color");
      if (fakeFlow && name === "hair") synthFlow(g, /pony/i.test(mesh.name) || /pony/i.test(mesh.parent?.name ?? ""));
      if (HAIR_MATS.has(name) && ensureFlow(g) !== "none") {
        f.flow = true;
        if (!g.userData.flowLogged) { g.userData.flowLogged = true; console.info(`[materials] ${mesh.name}: _flow ${g.userData.flowSpace}`); }
      }
      if (LOOKS[name]?.kind === "skin" && name === "skin") ensureThickness(g);
      f.mats++;
      facts.set(name, f);
    }
  }
  for (const mesh of meshes) {
    for (const mat of matsOf(mesh)) {
      const name = mat.name || "default";
      if (facts.get(name)?.flow) ensureZeroFlow(mesh.geometry);
      if (name === "hair_card") mesh.userData.noAO = true; // alpha cards would be solid quads in the AO normal pass
    }
  }

  const upgrade = (src: THREE.Material): THREE.MeshPhysicalMaterial => {
    const name = src.name || "default";
    const hit = byName.get(name);
    if (hit) return hit;
    const s = src as THREE.MeshStandardMaterial & Partial<THREE.MeshPhysicalMaterial>;
    const look = LOOKS[name] ?? { params: {} };
    const kind: Kind = look.kind ?? "plain";
    const f = facts.get(name) ?? { color: true, flow: false, mats: 0 };
    const kk = (kind === "hair" || kind === "card") && f.flow;
    const params: Partial<THREE.MeshPhysicalMaterialParameters> = { ...look.params };
    if (kind === "hair" && !kk && name === "hair") Object.assign(params, { sheen: 0.75, sheenRoughness: 0.32, sheenColor: c(0.5, 0.55, 0.66) });
    if (kk) Object.assign(params, { sheen: 0.2, sheenRoughness: 0.4, sheenColor: c(0.5, 0.55, 0.66), specularIntensity: 0.4 });
    const m = new THREE.MeshPhysicalMaterial({
      name,
      color: 0xffffff,
      vertexColors: f.color,
      map: s.map ?? null,
      side: src.side,
      roughness: s.roughness ?? 0.6,
      metalness: s.metalness ?? 0,
      ...params,
    });
    if (kind === "card") {
      m.side = THREE.DoubleSide;
      m.transparent = false;
      m.depthWrite = true;
      m.alphaTest = s.alphaTest > 0 ? s.alphaTest : 0.35;
      m.alphaToCoverage = elfQuality.alphaToCoverage;
      if (!s.map) console.warn("[materials] hair_card has no base colour texture; cards will render as solid ribbons");
      cardMats.add(m);
      m.addEventListener("dispose", () => cardMats.delete(m));
    }
    if (opts.hue && HUE_MATS.has(name) && m.sheen > 0) m.sheenColor.offsetHSL(opts.hue / (2 * Math.PI), 0, 0);
    if (s.emissive && (s.emissive.r + s.emissive.g + s.emissive.b) > 0) {
      m.emissive.copy(s.emissive);
      if (opts.hue) m.emissive.offsetHSL(opts.hue / (2 * Math.PI), 0, 0); // same direction as hueRotate (R -> G -> B)
      const g = GLOW[name] ?? { base: s.emissiveIntensity ?? 1, gain: 3 };
      m.emissiveIntensity = g.base;
      set.glow.push({ mat: m, base: g.base, gain: g.gain });
    }
    patch(m, uniforms, {
      name, kind, kk,
      hue: HUE_MATS.has(name),
      thin: name === "skin",
      detail: look.detail ?? null,
      tex,
    });
    byName.set(name, m);
    set.all.push(m);
    return m;
  };

  for (const mesh of meshes) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(upgrade) : upgrade(mesh.material);
  return set;
}

interface PatchOpts {
  name: string;
  kind: Kind;
  kk: boolean;
  hue: boolean;
  thin: boolean;
  detail: Detail | null;
  tex: ReturnType<typeof detailTextures>;
}

// ---------------------------------------------------------------- GLSL
const VERT_PARS = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec3 vDetX;
varying vec3 vDetY;
varying vec3 vDetZ;
attribute float _curv;
varying float vCurv;
#ifdef ELF_THIN
	attribute float _thin;
	varying float vThin;
#endif
#ifdef ELF_KK
	attribute vec3 _flow;
	varying vec3 vFlowView;
	varying vec3 vObjFlow;
#endif
`;

// after <skinnormal_vertex>: bind-pose position/normal + the object->view rotation of this vertex's skinning
const VERT_MAIN = /* glsl */ `
	vObjPos = position;
	vObjNrm = normal;
	mat3 elfM = mat3( modelViewMatrix );
	#ifdef USE_SKINNING
		elfM = elfM * mat3( skinMatrix );
	#endif
	vDetX = elfM[ 0 ];
	vDetY = elfM[ 1 ];
	vDetZ = elfM[ 2 ];
	vCurv = _curv;
	#ifdef ELF_THIN
		vThin = _thin;
	#endif
	#ifdef ELF_KK
		vObjFlow = _flow;
		vFlowView = elfM * _flow;
	#endif
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec3 vDetX;
varying vec3 vDetY;
varying vec3 vDetZ;
varying float vCurv;
uniform float uFlash;
uniform vec3 uFlashColor;
float elfGlow = 0.0;
#ifdef ELF_THIN
	varying float vThin;
	uniform vec3 uTransColor;
#endif
#ifdef ELF_SKIN
	const vec3 uSSSWrap = vec3( 0.55, 0.24, 0.14 );
#endif
#ifdef ELF_DETAIL
	uniform sampler2D uMacroMap;
	uniform vec4 uDetB; // macro: 1/tile, normal, albedo, roughness
	uniform vec4 uDetC; // edge: curvature start, albedo gain, roughness delta; w: micro feature size (m)
	#ifdef ELF_MICRO
		uniform sampler2D uMicroMap;
		uniform vec4 uDetA; // micro: 1/tile, normal, albedo, roughness
		uniform float uMicroOn;
	#endif
	vec3 elfTriW( vec3 n ) {
		vec3 w = n * n;
		w *= w;
		return w / ( w.x + w.y + w.z );
	}
	// triplanar: returns the perturbed object-space normal, ba = blended albedo/roughness channels
	vec3 elfTri( sampler2D t, vec3 p, vec3 n, vec3 w, float k, out vec2 ba ) {
		vec4 tx = texture2D( t, p.zy );
		vec4 ty = texture2D( t, p.xz );
		vec4 tz = texture2D( t, p.xy );
		vec2 nx = ( tx.xy * 2.0 - 1.0 ) * k;
		vec2 ny = ( ty.xy * 2.0 - 1.0 ) * k;
		vec2 nz = ( tz.xy * 2.0 - 1.0 ) * k;
		ba = tx.zw * w.x + ty.zw * w.y + tz.zw * w.z;
		vec3 r = vec3( n.x, n.y + nx.y, n.z + nx.x ) * w.x
			+ vec3( n.x + ny.x, n.y, n.z + ny.y ) * w.y
			+ vec3( n.x + nz.x, n.y + nz.y, n.z ) * w.z;
		return normalize( r );
	}
#endif
#ifdef ELF_KK
	varying vec3 vFlowView;
	varying vec3 vObjFlow;
	uniform vec4 uHairKK;    // shift1, shift2, exponent1, exponent2
	uniform vec3 uHairSpec1; // primary lobe colour * strength
	uniform float uHairSpec2; // secondary lobe strength (tinted by the hair albedo)
	uniform vec3 uHairCenter; // bind-pose head centre (strand noise origin)
	vec3 elfHairT = vec3( 0.0, 1.0, 0.0 );
	float elfHairJit = 0.0;
	float elfHairSpark = 1.0;
	float elfHairOn = 0.0;
	float elfHash( vec3 p ) {
		p = fract( p * 0.3183099 + 0.1 );
		p *= 17.0;
		return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
	}
	float elfNoise( vec3 x ) {
		vec3 i = floor( x );
		vec3 f = fract( x );
		f = f * f * ( 3.0 - 2.0 * f );
		return mix( mix( mix( elfHash( i ), elfHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( elfHash( i + vec3( 0, 1, 0 ) ), elfHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
			mix( mix( elfHash( i + vec3( 0, 0, 1 ) ), elfHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( elfHash( i + vec3( 0, 1, 1 ) ), elfHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
	}
	float elfKK( vec3 T, vec3 H, float e ) {
		float th = dot( T, H );
		float s = sqrt( max( 1.0 - th * th, 0.0 ) );
		return smoothstep( -1.0, 0.0, th ) * pow( s, e );
	}
	// fibre-like reflection: the normal around the strand that faces the viewer, mixed with the surface normal
	vec3 elfBent( vec3 N, vec3 V ) {
		if ( elfHairOn < 0.5 ) return N;
		vec3 bn = V - elfHairT * dot( elfHairT, V );
		float l = length( bn );
		return l > 1e-4 ? normalize( mix( bn / l, N, 0.45 ) ) : N;
	}
#endif
#ifdef ELF_EYE
	float elfEyeIris = 0.0;
#endif
`;

// at the top of RE_Direct_Physical
const DIRECT_KK = /* glsl */ `
	#ifdef ELF_KK
	if ( elfHairOn > 0.5 ) {
		vec3 N = geometryNormal;
		vec3 L = directLight.direction;
		float NL = dot( N, L );
		vec3 H = normalize( L + geometryViewDir );
		vec3 T1 = normalize( elfHairT + N * ( uHairKK.x + elfHairJit ) );
		vec3 T2 = normalize( elfHairT + N * ( uHairKK.y + elfHairJit ) );
		float vis = smoothstep( -0.25, 0.3, NL );
		vec3 spec = uHairSpec1 * elfKK( T1, H, uHairKK.z ) + uHairSpec2 * elfHairSpark * material.diffuseColor * elfKK( T2, H, uHairKK.w );
		reflectedLight.directSpecular += directLight.color * spec * vis;
		reflectedLight.directDiffuse += directLight.color * saturate( ( NL + 0.35 ) / 1.35 ) * BRDF_Lambert( material.diffuseContribution );
		return;
	}
	#endif
`;

const DIRECT_SKIN_DIFFUSE = /* glsl */ `
	#ifdef ELF_SKIN
		float sssNL = dot( geometryNormal, directLight.direction );
		vec3 sssW = uSSSWrap * ( 0.75 + 0.6 * saturate( vCurv * 0.012 ) );
		vec3 sssWrap = saturate( ( vec3( sssNL ) + sssW ) / ( 1.0 + sssW ) );
		reflectedLight.directDiffuse += sssWrap * directLight.color * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );
		#ifdef ELF_THIN
			vec3 tL = normalize( directLight.direction + geometryNormal * 0.3 );
			float back = pow( saturate( dot( geometryViewDir, - tL ) ), 3.0 ) + 0.35 * saturate( - sssNL );
			reflectedLight.directDiffuse += vThin * back * directLight.color * uTransColor * material.diffuseContribution;
		#endif
	#else
		${DIRECT_DIFFUSE_LINE}
	#endif
`;

const DIRECT_SKIN_SPEC = /* glsl */ `
	${DIRECT_SPEC_LINE}
	#ifdef ELF_SKIN
	{
		PhysicalMaterial m2 = material;
		m2.roughness = max( material.roughness * 0.55, 0.12 );
		specularBRDF = mix( specularBRDF, BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, m2 ), 0.2 );
	}
	#endif
`;

// after <normal_fragment_maps>: detail normal, albedo, roughness, edge wear; hair strand frame
const FRAG_DETAIL = /* glsl */ `
	#ifdef ELF_DETAIL
	{
		vec3 elfOn = normalize( vObjNrm ) * faceDirection;
		vec3 elfW = elfTriW( elfOn );
		vec2 elfMac;
		vec3 elfDN = elfTri( uMacroMap, vObjPos * uDetB.x, elfOn, elfW, uDetB.y, elfMac ) - elfOn;
		float elfMicA = 0.5;
		#ifdef ELF_MICRO
		if ( uMicroOn > 0.5 ) {
			vec3 fp = fwidth( vObjPos );
			float foot = max( max( fp.x, fp.y ), fp.z );
			float fade = 1.0 - smoothstep( uDetC.w * 0.3, uDetC.w * 1.4, foot );
			vec2 mic;
			vec3 dn = elfTri( uMicroMap, vObjPos * uDetA.x, elfOn, elfW, uDetA.y, mic ) - elfOn;
			elfDN += dn * fade;
			roughnessFactor += ( 1.0 - fade ) * uDetA.y * 0.05; // unresolved micro relief reads as roughness
			mic = mix( vec2( 0.5 ), mic, 0.4 + 0.6 * fade );
			elfMicA = mic.x;
			diffuseColor.rgb *= 1.0 + ( mic.x - 0.5 ) * 2.0 * uDetA.z;
			roughnessFactor += ( mic.y - 0.5 ) * 2.0 * uDetA.w;
		}
		#endif
		normal = normalize( normal + mat3( vDetX, vDetY, vDetZ ) * elfDN );
		diffuseColor.rgb *= 1.0 + ( elfMac.x - 0.5 ) * 2.0 * uDetB.z;
		#ifdef ELF_SKIN
			diffuseColor.rgb *= 1.0 + ( elfMac.y - 0.5 ) * vec3( 0.14, -0.03, -0.06 ); // blotchy redness
		#endif
		roughnessFactor += ( elfMac.y - 0.5 ) * 2.0 * uDetB.w;
		float elfEdge = smoothstep( uDetC.x, uDetC.x * 2.5, vCurv ) * ( 0.5 + elfMicA );
		diffuseColor.rgb *= 1.0 + elfEdge * uDetC.y;
		roughnessFactor = clamp( roughnessFactor + elfEdge * uDetC.z, 0.04, 1.0 );
	}
	#endif
	#ifdef ELF_KK
	{
		float tl = length( vFlowView );
		elfHairOn = step( 0.2, tl );
		vec3 T = tl > 1e-4 ? vFlowView / tl : vec3( 0.0, 1.0, 0.0 );
		T -= normal * dot( T, normal );
		float l2 = length( T );
		if ( l2 < 1e-3 ) elfHairOn = 0.0;
		elfHairT = l2 > 1e-4 ? T / l2 : vec3( 0.0, 1.0, 0.0 );
		// clump-scale variation stretched along the strands (no strand parametrisation without UVs, so
		// keep it soft; fine strand detail comes from the hair cards)
		vec3 of = vObjFlow / max( length( vObjFlow ), 1e-4 );
		vec3 q = vObjPos - uHairCenter;
		q -= of * dot( q, of ) * 0.85;
		float foot = length( fwidth( vObjPos ) );
		float fine = 1.0 - smoothstep( 0.0004, 0.0015, foot );
		float n1 = elfNoise( q * 260.0 );
		float n2 = elfNoise( q * 900.0 + 17.0 );
		elfHairJit = ( n1 - 0.5 ) * 0.35 + ( n2 - 0.5 ) * 0.15 * fine;
		elfHairSpark = mix( 1.0, 0.5 + n2, fine );
		diffuseColor.rgb *= mix( 1.0, 0.86 + 0.28 * n1, elfHairOn );
	}
	#endif
`;

const FRAG_EYE = /* glsl */ `
	#if defined( ELF_EYE ) && defined( USE_MAP )
	{
		// texture is polar: v = 0 pupil, ~0.05-0.148 iris, sclera beyond
		float ev = vMapUv.y;
		float ring = smoothstep( 0.09, 0.14, ev ) * ( 1.0 - smoothstep( 0.15, 0.2, ev ) );
		diffuseColor.rgb *= 1.0 - 0.55 * ring;
		float sclera = smoothstep( 0.145, 0.165, ev );
		diffuseColor.rgb *= mix( 1.0, 0.9, sclera );
		float lid = smoothstep( 0.2, 0.42, ev );
		diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.8, 0.7, 0.68 ), lid );
		elfEyeIris = 1.0 - sclera;
	}
	#endif
`;

function patch(m: THREE.MeshPhysicalMaterial, u: CharacterUniforms, f: PatchOpts) {
  const d = f.detail;
  const defines: Record<string, string> = {};
  if (f.kind === "skin") defines.ELF_SKIN = "";
  if (f.thin) defines.ELF_THIN = "";
  if (d) defines.ELF_DETAIL = "";
  if (d?.micro) defines.ELF_MICRO = "";
  if (f.kk) defines.ELF_KK = "";
  if (f.kind === "eye") defines.ELF_EYE = "";
  if (f.kind !== "card") defines.ELF_BLOOM = "";
  m.defines = { ...(m.defines ?? {}), ...defines };

  const detU = d ? {
    uMacroMap: { value: f.tex.macro },
    uDetB: { value: new THREE.Vector4(1 / TILE.macro, d.ma[0], d.ma[1], d.ma[2]) },
    uDetC: { value: new THREE.Vector4(d.edge?.[0] ?? 1e9, d.edge?.[1] ?? 0, d.edge?.[2] ?? 0, d.micro ? TILE[d.micro] / 24 : 1) },
    uMicroMap: { value: d.micro ? f.tex[d.micro] : null },
    uDetA: { value: d.micro && d.mi ? new THREE.Vector4(1 / TILE[d.micro], d.mi[0], d.mi[1], d.mi[2]) : new THREE.Vector4() },
    uMicroOn: elfQuality.micro,
  } : null;

  m.userData.elfUniforms = detU; // live tuning from the console
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFlash = u.flash;
    shader.uniforms.uFlashColor = u.flashColor;
    if (detU) Object.assign(shader.uniforms, detU);
    if (f.thin) shader.uniforms.uTransColor = { value: SKIN_TRANS };
    if (f.kk) {
      shader.uniforms.uHairKK = { value: HAIR.kk };
      shader.uniforms.uHairSpec1 = { value: HAIR.spec1 };
      shader.uniforms.uHairSpec2 = { value: HAIR.spec2 };
      shader.uniforms.uHairCenter = { value: HAIR.center };
    }

    // ---- vertex
    let vs = shader.vertexShader;
    vs = vs.replace("#include <common>", "#include <common>\n" + VERT_PARS);
    vs = vs.replace("#include <skinnormal_vertex>", "#include <skinnormal_vertex>\n" + VERT_MAIN);
    shader.vertexShader = vs;

    // ---- fragment
    let fs = shader.fragmentShader;
    let head = FRAG_PARS;
    if (f.hue) {
      shader.uniforms.uHue = u.hue;
      head += `uniform float uHue;
vec3 hueRotate( vec3 c, float a ) {
  const vec3 k = vec3( 0.57735 );
  float ca = cos( a );
  return max( c * ca + cross( k, c ) * sin( a ) + k * dot( k, c ) * ( 1.0 - ca ), 0.0 );
}
`;
      fs = fs.replace("#include <color_fragment>", "#include <color_fragment>\n\tdiffuseColor.rgb = hueRotate( diffuseColor.rgb, uHue );");
    }
    fs = fs.replace("#include <common>", "#include <common>\n" + head);

    // lighting: inline the physical chunk so only this material's RE_Direct changes
    if (f.kind === "skin" || f.kk) {
      let chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
      const ok = DIRECT_FN.test(chunk) && chunk.includes(DIRECT_DIFFUSE_LINE) && chunk.includes(DIRECT_SPEC_LINE);
      if (ok) {
        chunk = chunk.replace(DIRECT_FN, (sig) => sig + "\n" + DIRECT_KK);
        chunk = chunk.replace(DIRECT_DIFFUSE_LINE, DIRECT_SKIN_DIFFUSE);
        chunk = chunk.replace(DIRECT_SPEC_LINE, DIRECT_SKIN_SPEC);
        fs = fs.replace("#include <lights_physical_pars_fragment>", chunk);
      } else warnOnce("RE_Direct_Physical");
    }
    if (f.kk) {
      const maps = THREE.ShaderChunk.lights_fragment_maps;
      if (maps.includes(IBL_LINE)) {
        fs = fs.replace("#include <lights_fragment_maps>", maps.replace(IBL_LINE,
          "vec3 iblRadiance = getIBLRadiance( geometryViewDir, elfBent( geometryNormal, geometryViewDir ), material.roughness );"));
      } else warnOnce("lights_fragment_maps");
    }
    fs = fs.replace("#include <color_fragment>", "#include <color_fragment>\n" + FRAG_EYE);
    fs = fs.replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + FRAG_DETAIL);

    // eyes: a small camera-side catchlight on the cornea keeps them alive from every angle
    // hit flash (rim-weighted additive colour) + bloom mask in alpha
    fs = fs.replace(
      "#include <opaque_fragment>",
      `#ifdef ELF_EYE
	{ vec3 elfR = reflect( - normalize( vViewPosition ), normalize( nonPerturbedNormal ) );
	  float cl = pow( saturate( dot( elfR, normalize( vec3( 0.35, 0.45, 1.0 ) ) ) ), 350.0 );
	  outgoingLight += vec3( 1.0, 0.97, 0.92 ) * cl * 2.5; }
	#endif
	{ float rim = 1.0 - saturate( dot( normalize( normal ), normalize( vViewPosition ) ) );
	  float fl = uFlash * ( 0.35 + 1.4 * rim * rim );
	  outgoingLight += uFlashColor * fl;
	  elfGlow = saturate( max3( totalEmissiveRadiance ) * 4.0 + fl * 0.6 ); }
	#include <opaque_fragment>
	#ifdef ELF_BLOOM
		gl_FragColor.a = 1.0 + elfGlow;
	#endif`,
    );
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => `elf3:${f.name}:${Object.keys(defines).sort().join(",")}:${f.hue ? 1 : 0}`;
}
