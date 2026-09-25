import * as migration_20250929_111647 from './20250929_111647';
import * as migration_20260925_223056_init from './20260925_223056_init';

export const migrations = [
  {
    up: migration_20250929_111647.up,
    down: migration_20250929_111647.down,
    name: '20250929_111647',
  },
  {
    up: migration_20260925_223056_init.up,
    down: migration_20260925_223056_init.down,
    name: '20260925_223056_init'
  },
];
