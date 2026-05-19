import fs from 'fs';
import path from 'path';

import { SkillMetadata } from '../models/index.js';

export interface LoadedSkillContent {
  id: string;
  path: string;
  body: string;
}

export function loadSkillContent(skill: SkillMetadata): LoadedSkillContent {
  const skillMdPath = path.join(skill.path, 'SKILL.md');
  const body = fs.existsSync(skillMdPath) ? fs.readFileSync(skillMdPath, 'utf8') : '';
  return { id: skill.id, path: skillMdPath, body };
}
