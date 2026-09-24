import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { R2InspectorComponent } from './r2-inspector.component';
import { ApiService } from '../../../services/api.service';

/**
 * R2InspectorComponent — a super-admin read-only R2 object browser. These specs
 * lock the REAL backend contract (GET /api/admin/r2/{buckets,:bucket/objects,
 * :bucket/object}) so the UI can never drift to a hallucinated shape:
 *   - buckets come back as a plain string[] (the server allowlist),
 *   - objects are cursor-paginated {key,size,uploaded,etag,contentType}, appended,
 *   - `truncated` (NOT list_complete) drives "load more",
 *   - selecting an object loads its metadata (HEAD),
 *   - all reads go through /admin/r2/* (ApiService prepends /api).
 * The change handler is exercised via a plain {target:{value}} cast (a real
 * Event's `target` is read-only).
 */
describe('R2InspectorComponent', () => {
  let component: R2InspectorComponent;
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get']);
    TestBed.configureTestingModule({
      imports: [R2InspectorComponent],
      providers: [{ provide: ApiService, useValue: api }],
    });
    component = TestBed.createComponent(R2InspectorComponent).componentInstance;
  });

  const evt = (value: string): Event => ({ target: { value } }) as unknown as Event;

  describe('loadBuckets', () => {
    it('calls /admin/r2/buckets on init and stores the string[] allowlist', () => {
      api.get.and.returnValue(of({ buckets: ['SITES_BUCKET'] }));
      component.ngOnInit();
      expect(api.get).toHaveBeenCalledWith('/admin/r2/buckets');
      expect(component.buckets()).toEqual(['SITES_BUCKET']);
      expect(component.loadingBuckets()).toBe(false);
    });

    it('surfaces an honest error on failure (never a fabricated empty list)', () => {
      api.get.and.returnValue(throwError(() => new Error('boom')));
      component.loadBuckets();
      expect(component.bucketLoadError()).toContain('Could not load');
      expect(component.loadingBuckets()).toBe(false);
    });
  });

  describe('bucket selection', () => {
    it('onBucketChange sets the bucket and loads its first object page', () => {
      api.get.and.returnValue(of({ bucket: 'SITES_BUCKET', objects: [], truncated: false }));
      component.onBucketChange(evt('SITES_BUCKET'));
      expect(component.selectedBucket()).toBe('SITES_BUCKET');
      expect(api.get).toHaveBeenCalledWith('/admin/r2/SITES_BUCKET/objects');
    });

    it('selecting the empty option clears the bucket and does NOT query objects', () => {
      component.onBucketChange(evt(''));
      expect(component.selectedBucket()).toBeNull();
      expect(api.get).not.toHaveBeenCalled();
    });
  });

  describe('loadObjects', () => {
    beforeEach(() => {
      api.get.and.returnValue(of({ bucket: 'SITES_BUCKET', objects: [], truncated: false }));
      component.selectBucket('SITES_BUCKET');
      api.get.calls.reset();
    });

    it('stores objects and derives hasMore from `truncated` (not list_complete)', () => {
      api.get.and.returnValue(
        of({
          bucket: 'SITES_BUCKET',
          objects: [
            {
              key: 'sites/a/index.html',
              size: 100,
              uploaded: '2026-09-01T00:00:00Z',
              etag: 'e',
              contentType: 'text/html',
            },
          ],
          truncated: true,
          cursor: 'c1',
        }),
      );
      component.loadObjects();
      expect(api.get).toHaveBeenCalledWith('/admin/r2/SITES_BUCKET/objects');
      expect(component.objects().map((o) => o.key)).toEqual(['sites/a/index.html']);
      expect(component.hasMore()).toBe(true);
    });

    it('encodes the prefix into the request', () => {
      component.prefixFilter.set('sites/');
      api.get.and.returnValue(of({ bucket: 'SITES_BUCKET', objects: [], truncated: false }));
      component.loadObjects();
      expect(api.get).toHaveBeenCalledWith(jasmine.stringContaining('prefix=sites%2F'));
    });

    it('APPENDS the next page on loadMore (never replaces)', () => {
      api.get.and.returnValues(
        of({
          bucket: 'SITES_BUCKET',
          objects: [{ key: 'k1', size: 1, uploaded: null, etag: 'a', contentType: null }],
          truncated: true,
          cursor: 'c1',
        }),
        of({
          bucket: 'SITES_BUCKET',
          objects: [{ key: 'k2', size: 2, uploaded: null, etag: 'b', contentType: null }],
          truncated: false,
        }),
      );
      component.loadObjects();
      expect(component.objects().map((o) => o.key)).toEqual(['k1']);
      component.loadMore();
      expect(component.objects().map((o) => o.key)).toEqual(['k1', 'k2']);
      expect(component.hasMore()).toBe(false);
    });

    it('surfaces an objects error', () => {
      api.get.and.returnValue(throwError(() => new Error('nope')));
      component.loadObjects();
      expect(component.objectsLoadError()).toContain('Could not load');
    });
  });

  describe('selectObject + loadObject', () => {
    beforeEach(() => {
      api.get.and.returnValue(of({ bucket: 'SITES_BUCKET', objects: [], truncated: false }));
      component.selectBucket('SITES_BUCKET');
      api.get.calls.reset();
    });

    it('loads object metadata from /admin/r2/:bucket/object', () => {
      api.get.and.returnValue(
        of({
          bucket: 'SITES_BUCKET',
          key: 'sites/a/x',
          found: true,
          size: 42,
          uploaded: null,
          etag: 'e',
          contentType: 'text/html',
          customMetadata: null,
        }),
      );
      component.selectObject('sites/a/x');
      expect(component.selectedKey()).toBe('sites/a/x');
      expect(api.get).toHaveBeenCalledWith('/admin/r2/SITES_BUCKET/object?key=sites%2Fa%2Fx');
      expect(component.obj()?.found).toBe(true);
      expect(component.obj()?.size).toBe(42);
    });

    it('surfaces an object error', () => {
      api.get.and.returnValue(throwError(() => new Error('x')));
      component.selectObject('k');
      expect(component.objLoadError()).toContain('Could not load');
    });
  });

  describe('sizeLabel', () => {
    it('formats bytes humanely; null → em dash', () => {
      expect(component.sizeLabel(null)).toBe('—');
      expect(component.sizeLabel(512)).toBe('512 B');
      expect(component.sizeLabel(1536)).toBe('1.5 KB');
      expect(component.sizeLabel(5 * 1024 * 1024)).toBe('5.0 MB');
    });
  });

  describe('dateLabel', () => {
    it('renders the stored UTC timestamp (no local-tz shift); null → em dash', () => {
      expect(component.dateLabel(null)).toBe('—');
      expect(component.dateLabel('2026-09-01T12:34:56.000Z')).toBe('2026-09-01 12:34:56 UTC');
    });
  });
});
