import type { Workspace } from '../../shared/types.js';
import { RecoveryError } from '../errors.js';
import type { IncidentDefinition } from './types.js';
import { onboarding } from './onboarding.js';
import { release } from './release.js';

/** Supported incident definitions. Adding an incident adds an entry here, not engine code. */
const definitions: Record<string, IncidentDefinition> = { onboarding, release };

/** Workspaces saved before incident types existed are onboarding incidents. */
export function definitionFor(w: Workspace): IncidentDefinition {
  const definition = definitions[w.incident ?? 'onboarding'];
  if (!definition) throw new RecoveryError('This workspace names an unsupported incident type.', 422);
  return definition;
}
