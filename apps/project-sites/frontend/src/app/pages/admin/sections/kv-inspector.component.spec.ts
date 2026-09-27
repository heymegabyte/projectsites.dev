import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { KvInspectorComponent } from './kv-inspector.component';
import { ApiService } from '../../../services/api.service';

/**
 * KvInspectorComponent — a super-admin read-only KV browser. These specs lock the
 * REAL backend contract (GET /api/admin/kv/{namespaces,:binding/keys,:binding/value})
 * so the UI can never silently drift back to a hallucinated endpoint shape:
 *   - namespaces come back as a plain string[] (the server binding allowlist),
 *   - keys are cursor-paginated objects ({name, ...}), appended across pages,
 *   - selecting a key loads its value/metadata/TTL,
 *   - all reads go through /admin/kv/* (ApiService prepends /api).
 * A change-event handler is exercised via a plain {target:{value}} cast (a real
 * Event's `target` is read-only), the class of bug that sank the first draft.
 */
describe('KvInspectorComponent', () => {
  let component: KvInspectorComponent;
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get']);
    TestBed.configureTestingModule({
      imports: [KvInspectorComponent],
      providers: [{ provide: ApiService, useValue: api }],
    });
    const fixture = TestBed.createComponent(KvInspectorComponent);
    component = fixture.componentInstance;
  });

  /** A DOM-free change/input event carrying a value (real Event.target is read-only). */
  const evt = (value: string): Event => ({ target: { value } }) as unknown as Event;

  describe('loadNamespaces', () => {
    it('calls /admin/kv/namespaces on init and stores the string[] allowlist', () => {
      api.get.and.returnValue(of({ namespaces: ['CACHE_KV', 'PROMPT_STORE'] }));
      component.ngOnInit();
      expect(api.get).toHaveBeenCalledWith('/admin/kv/namespaces');
      expect(component.namespaces()).toEqual(['CACHE_KV', 'PROMPT_STORE']);
      expect(component.loadingNamespaces()).toBe(false);
    });

    it('surfaces an honest error (never a fabricated empty list) on failure', () => {
      api.get.and.returnValue(throwError(() => new Error('boom')));
      component.loadNamespaces();
      expect(component.namespaceLoadError()).toContain('Could not load');
      expect(component.loadingNamespaces()).toBe(false);
    });
  });

  describe('binding selection', () => {
    it('onBindingChange sets the binding and loads its first key page', () => {
      api.get.and.returnValue(of({ binding: 'CACHE_KV', keys: [], list_complete: true }));
      component.onBindingChange(evt('CACHE_KV'));
      expect(component.selectedBinding()).toBe('CACHE_KV');
      expect(api.get).toHaveBeenCalledWith('/admin/kv/CACHE_KV/keys');
    });

    it('selecting an empty option clears the binding and does NOT query keys', () => {
      component.onBindingChange(evt(''));
      expect(component.selectedBinding()).toBeNull();
      expect(api.get).not.toHaveBeenCalled();
    });
  });

  describe('loadKeys', () => {
    beforeEach(() => {
      // Seed the binding WITHOUT triggering a load, so each test drives loadKeys itself.
      api.get.and.returnValue(of({ binding: 'CACHE_KV', keys: [], list_complete: true }));
      component.selectBinding('CACHE_KV');
      api.get.calls.reset();
    });

    it('stores {name} entries and derives hasMoreKeys from list_complete', () => {
      api.get.and.returnValue(
        of({
          binding: 'CACHE_KV',
          keys: [{ name: 'host:a' }, { name: 'host:b' }],
          list_complete: false,
          cursor: 'c1',
        }),
      );
      component.loadKeys();
      expect(api.get).toHaveBeenCalledWith('/admin/kv/CACHE_KV/keys');
      expect(component.keys().map((k) => k.name)).toEqual(['host:a', 'host:b']);
      expect(component.hasMoreKeys()).toBe(true);
    });

    it('encodes the prefix into the request', () => {
      component.prefixFilter.set('host:');
      api.get.and.returnValue(of({ binding: 'CACHE_KV', keys: [], list_complete: true }));
      component.loadKeys();
      expect(api.get).toHaveBeenCalledWith(jasmine.stringContaining('prefix=host%3A'));
    });

    it('APPENDS the next page on loadMoreKeys (never replaces)', () => {
      api.get.and.returnValues(
        of({ binding: 'CACHE_KV', keys: [{ name: 'k1' }], list_complete: false, cursor: 'c1' }),
        of({ binding: 'CACHE_KV', keys: [{ name: 'k2' }], list_complete: true }),
      );
      component.loadKeys();
      expect(component.keys().map((k) => k.name)).toEqual(['k1']);
      component.loadMoreKeys();
      expect(component.keys().map((k) => k.name)).toEqual(['k1', 'k2']);
      expect(component.hasMoreKeys()).toBe(false);
    });

    it('surfaces a keys error', () => {
      api.get.and.returnValue(throwError(() => new Error('nope')));
      component.loadKeys();
      expect(component.keysLoadError()).toContain('Could not load');
    });
  });

  describe('applyPrefix resets pagination', () => {
    it('clears keys + cursor and reloads from the first page', () => {
      api.get.and.returnValue(
        of({ binding: 'CACHE_KV', keys: [{ name: 'k1' }], list_complete: false, cursor: 'c1' }),
      );
      component.selectBinding('CACHE_KV'); // loads page 1
      component.prefixFilter.set('host:');
      api.get.calls.reset();
      api.get.and.returnValue(of({ binding: 'CACHE_KV', keys: [{ name: 'host:x' }], list_complete: true }));
      component.applyPrefix();
      expect(component.keys().map((k) => k.name)).toEqual(['host:x']); // reset, not appended
      expect(component.selectedKey()).toBeNull();
    });
  });

  describe('selectKey + loadValue', () => {
    beforeEach(() => {
      api.get.and.returnValue(of({ binding: 'CACHE_KV', keys: [], list_complete: true }));
      component.selectBinding('CACHE_KV');
      api.get.calls.reset();
    });

    it('loads the value for the selected key from /admin/kv/:binding/value', () => {
      api.get.and.returnValue(
        of({ binding: 'CACHE_KV', key: 'host:a', value: 'v', metadata: null, truncated: false, ttl: null }),
      );
      component.selectKey('host:a');
      expect(component.selectedKey()).toBe('host:a');
      expect(api.get).toHaveBeenCalledWith('/admin/kv/CACHE_KV/value?key=host%3Aa');
      expect(component.value()?.value).toBe('v');
      expect(component.valueLoading()).toBe(false);
    });

    it('surfaces a value error', () => {
      api.get.and.returnValue(throwError(() => new Error('x')));
      component.selectKey('host:a');
      expect(component.valueLoadError()).toContain('Could not load');
    });
  });

  describe('ttlLabel', () => {
    it('renders null as "No expiry" (never a fabricated 0)', () => {
      expect(component.ttlLabel(null)).toBe('No expiry');
      expect(component.ttlLabel(30)).toBe('30s');
      expect(component.ttlLabel(120)).toBe('2m');
      expect(component.ttlLabel(7200)).toBe('2h');
    });
  });
});
