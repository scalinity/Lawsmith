import RAPIER from '@dimforge/rapier3d-compat';

/** Fixed simulation step h (SPEC §2.2). */
export const STEP_SECONDS = 1 / 120;

export interface SimulationReady {
  rapierVersion: string;
  world: RAPIER.World;
  /** Effective engine integration parameters read back after configuration (SPEC §9.3). */
  effectiveProfile: Record<string, number>;
}

/**
 * Initializes the Rapier WASM module and creates the empty world the simulation host
 * will own. No engine object exists before `RAPIER.init()` resolves.
 */
export async function initSimulation(): Promise<SimulationReady> {
  await RAPIER.init();

  // Gravity enters through the Lawsmith force adapter, so the engine's stays zero (SPEC §9.1).
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = STEP_SECONDS;
  const params = world.integrationParameters;
  params.numSolverIterations = 4;
  params.numInternalPgsIterations = 1;
  params.maxCcdSubsteps = 1;
  params.lengthUnit = 1;

  // One step proves the WASM module executes, not only that it loaded.
  world.step();

  return {
    rapierVersion: RAPIER.version(),
    world,
    effectiveProfile: {
      dt: params.dt,
      numSolverIterations: params.numSolverIterations,
      numInternalPgsIterations: params.numInternalPgsIterations,
      maxCcdSubsteps: params.maxCcdSubsteps,
      lengthUnit: params.lengthUnit,
      normalizedAllowedLinearError: params.normalizedAllowedLinearError,
      normalizedPredictionDistance: params.normalizedPredictionDistance,
    },
  };
}
