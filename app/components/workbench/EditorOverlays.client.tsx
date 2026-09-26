/*
 * EditorOverlays — escape-hatch action(s) shared by the editor surface.
 *
 *   • openInStackBlitz — POSTs the current workspace into a fresh StackBlitz
 *     Vite project so users can debug outside bolt.diy.
 *
 * (The Cmd+P quick-jump palette and the `?` keyboard-shortcuts overlay used to
 * live here too; they were removed per product decision — no third-party deps
 * remain.)
 */
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';

/*
 * StackBlitz escape hatch — POSTs the workspace into the v2 SDK API and
 * opens the result in a new tab. Falls back to a plain new-project URL
 * if the form-post is blocked.
 */
export function openInStackBlitz() {
  try {
    const files = workbenchStore.files.get();
    const form = document.createElement('form');
    form.action = 'https://stackblitz.com/run?embed=0';
    form.method = 'POST';
    form.target = '_blank';
    form.style.display = 'none';

    const add = (name: string, value: string) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    };

    add('project[title]', 'bolt.diy export');
    add('project[description]', 'Exported from editor.projectsites.dev');
    add('project[template]', 'node');

    let count = 0;

    for (const [fullPath, dirent] of Object.entries(files)) {
      if (!dirent || dirent.type !== 'file' || dirent.isBinary) {
        continue;
      }

      const rel = fullPath.replace(/^\/home\/project\/?/, '');

      if (!rel || /\/(node_modules|\.git)\//.test('/' + rel)) {
        continue;
      }

      add(`project[files][${rel}]`, (dirent.content as string) ?? '');
      count++;
    }

    if (count === 0) {
      toast.error('No files to export');
      return;
    }

    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
    toast.success(`Opened ${count} files in StackBlitz`);
  } catch (error) {
    console.warn('StackBlitz export failed', error);
    toast.error('Failed to open in StackBlitz');
    window.open('https://stackblitz.com/fork/vitejs-vite', '_blank', 'noopener,noreferrer');
  }
}
