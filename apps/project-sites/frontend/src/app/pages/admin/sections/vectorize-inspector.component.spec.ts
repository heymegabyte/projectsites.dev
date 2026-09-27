import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { VectorizeInspectorComponent } from './vectorize-inspector.component';
import { ApiService } from '../../../services/api.service';

/**
 * VectorizeInspectorComponent — a super-admin, read-only Vectorize index browser. These
 * specs lock the REAL backend contract (GET /api/admin/vectorize/{indexes,indexes/:name})
 * so the UI can't drift: indexes come back as {indexes,available}; an `available:false`
 * response is surfaced as an honest "not available" (never a fabricated empty list);
 * selecting an index loads its describe (config + vectorCount). All reads go through
 * /admin/vectorize/* (ApiService prepends /api).
 */
describe('VectorizeInspectorComponent', () => {
  let component: VectorizeInspectorComponent;
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get']);
    TestBed.configureTestingModule({
      imports: [VectorizeInspectorComponent],
      providers: [{ provide: ApiService, useValue: api }],
    });
    component = TestBed.createComponent(VectorizeInspectorComponent).componentInstance;
  });

  describe('loadIndexes', () => {
    it('calls /admin/vectorize/indexes on init and stores the available index list', () => {
      api.get.and.returnValue(
        of({
          available: true,
          indexes: [
            { name: 'projectsites-rag', dimensions: 768, metric: 'cosine', description: null, created: null, modified: null },
          ],
        }),
      );
      component.ngOnInit();
      expect(api.get).toHaveBeenCalledWith('/admin/vectorize/indexes');
      expect(component.available()).toBe(true);
      expect(component.indexes().map((i) => i.name)).toEqual(['projectsites-rag']);
      expect(component.loading()).toBe(false);
    });

    it('surfaces available:false (honest "not available", never a fabricated empty list)', () => {
      api.get.and.returnValue(of({ available: false, indexes: [], reason: 'cf_403' }));
      component.loadIndexes();
      expect(component.available()).toBe(false);
      expect(component.indexes()).toEqual([]);
      expect(component.loading()).toBe(false);
    });

    it('surfaces an honest error on a transport failure', () => {
      api.get.and.returnValue(throwError(() => new Error('boom')));
      component.loadIndexes();
      expect(component.loadError()).toContain('Could not load');
      expect(component.loading()).toBe(false);
    });
  });

  describe('selectIndex + loadDetail', () => {
    it('loads the describe from /admin/vectorize/indexes/:name (config + vector count)', () => {
      api.get.and.returnValue(
        of({
          found: true,
          name: 'projectsites-rag',
          dimensions: 768,
          metric: 'cosine',
          description: 'RAG',
          created: null,
          modified: null,
          vectorCount: 4210,
          processedUpToMutation: 'm-9',
        }),
      );
      component.selectIndex('projectsites-rag');
      expect(component.selectedName()).toBe('projectsites-rag');
      expect(api.get).toHaveBeenCalledWith('/admin/vectorize/indexes/projectsites-rag');
      expect(component.detail()?.found).toBe(true);
      expect(component.detail()?.vectorCount).toBe(4210);
    });

    it('surfaces an honest error when the describe fails', () => {
      api.get.and.returnValue(throwError(() => new Error('x')));
      component.selectIndex('nope');
      expect(component.detailError()).toContain('Could not load');
    });
  });

  describe('formatting', () => {
    it('countLabel thousands-separates; dateLabel renders stored UTC (null → em dash)', () => {
      expect(component.countLabel(4210)).toBe('4,210');
      expect(component.dateLabel(null)).toBe('—');
      expect(component.dateLabel('2026-09-01T12:34:56.000Z')).toBe('2026-09-01 12:34:56 UTC');
    });
  });
});
