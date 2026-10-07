import { stashCreateFiles, restoreCreateFiles, clearCreateFiles } from './create-file-stash';

/**
 * create-file-stash — the IndexedDB hand-off that lets signed-out `/create` uploads survive the
 * `/signin` OAuth bounce (localStorage can't hold a File; IndexedDB can). Karma runs in real
 * ChromeHeadless, so IndexedDB is available here (unlike jsdom). Each spec clears the slot first so
 * ordering never leaks state.
 */
function file(name: string, bytes: string, type: string): File {
  return new File([bytes], name, { type });
}

describe('create-file-stash (IndexedDB signin-bounce hand-off)', () => {
  beforeEach(async () => {
    await clearCreateFiles();
  });
  afterEach(async () => {
    await clearCreateFiles();
  });

  it('round-trips logo + favicon + additional files (name/size/type preserved)', async () => {
    const logo = file('logo.png', 'PNGDATA', 'image/png');
    const favicon = file('favicon.ico', 'ICO', 'image/x-icon');
    const a1 = file('team.jpg', 'JPEGBYTES', 'image/jpeg');
    const a2 = file('menu.pdf', '%PDF-1.4', 'application/pdf');

    await stashCreateFiles({ logo, favicon, additional: [a1, a2] });
    const restored = await restoreCreateFiles();

    expect(restored).not.toBeNull();
    expect(restored!.logo).toBeInstanceOf(File);
    expect(restored!.logo!.name).toBe('logo.png');
    expect(restored!.logo!.type).toBe('image/png');
    expect(restored!.favicon!.name).toBe('favicon.ico');
    expect(restored!.additional.length).toBe(2);
    expect(restored!.additional.map((f) => f.name).sort()).toEqual(['menu.pdf', 'team.jpg']);
    expect(restored!.additional[0].size).toBeGreaterThan(0);
  });

  it('stashes an additional-only set (no logo/favicon) and restores it', async () => {
    await stashCreateFiles({ logo: null, favicon: null, additional: [file('a.png', 'X', 'image/png')] });
    const restored = await restoreCreateFiles();
    expect(restored).not.toBeNull();
    expect(restored!.logo).toBeNull();
    expect(restored!.favicon).toBeNull();
    expect(restored!.additional.length).toBe(1);
  });

  it('restore returns null when nothing is stashed', async () => {
    expect(await restoreCreateFiles()).toBeNull();
  });

  it('treats an all-empty stash as no stash (null)', async () => {
    await stashCreateFiles({ logo: null, favicon: null, additional: [] });
    expect(await restoreCreateFiles()).toBeNull();
  });

  it('clear removes the stash', async () => {
    await stashCreateFiles({ logo: file('l.png', 'X', 'image/png'), favicon: null, additional: [] });
    expect(await restoreCreateFiles()).not.toBeNull();
    await clearCreateFiles();
    expect(await restoreCreateFiles()).toBeNull();
  });

  it('is single-slot — a second stash overwrites the first', async () => {
    await stashCreateFiles({ logo: file('first.png', 'A', 'image/png'), favicon: null, additional: [] });
    await stashCreateFiles({ logo: file('second.png', 'B', 'image/png'), favicon: null, additional: [] });
    const restored = await restoreCreateFiles();
    expect(restored!.logo!.name).toBe('second.png');
  });
});
