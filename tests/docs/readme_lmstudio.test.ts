import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

describe('README LM Studio configuration docs', () => {
  test('documents LM Studio as a Live provider without adding GUI categories', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

    expect(readme).toContain('lmstudio:');
    expect(readme).toContain('label: LM Studio');
    expect(readme).toContain('base_url: http://127.0.0.1:1234/v1');
    expect(readme).toContain('api_key_env: LMSTUDIO_API_KEY');
    expect(readme).toContain('LMSTUDIO_API_KEY=not-needed');
    expect(readme).toContain('Invoke-RestMethod http://127.0.0.1:1234/v1/models');
    expect(readme).toContain('LM Studio is just another Live provider');
    expect(readme).toContain('no separate Local/Cloud GUI mode');
  });
});
