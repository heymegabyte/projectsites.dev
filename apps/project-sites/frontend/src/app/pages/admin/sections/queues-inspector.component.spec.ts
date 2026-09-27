import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { QueuesInspectorComponent } from './queues-inspector.component';
import { ApiService } from '../../../services/api.service';

/**
 * QueuesInspectorComponent — a super-admin, read-only Queues browser. Locks the REAL
 * backend contract (GET /api/admin/queues{,/:id}): queues come back as {queues,available};
 * an `available:false` response is surfaced as an honest "not available" (never a fabricated
 * empty list); selecting a queue loads its settings + producers/consumers. All reads go
 * through /admin/queues/* (ApiService prepends /api).
 */
describe('QueuesInspectorComponent', () => {
  let component: QueuesInspectorComponent;
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(() => {
    api = jasmine.createSpyObj('ApiService', ['get']);
    TestBed.configureTestingModule({
      imports: [QueuesInspectorComponent],
      providers: [{ provide: ApiService, useValue: api }],
    });
    component = TestBed.createComponent(QueuesInspectorComponent).componentInstance;
  });

  describe('loadQueues', () => {
    it('calls /admin/queues on init and stores the available queue list', () => {
      api.get.and.returnValue(
        of({
          available: true,
          queues: [{ id: 'q1', name: 'gitlink-jobs', producers: 1, consumers: 1, created: null, modified: null }],
        }),
      );
      component.ngOnInit();
      expect(api.get).toHaveBeenCalledWith('/admin/queues');
      expect(component.available()).toBe(true);
      expect(component.queues().map((q) => q.name)).toEqual(['gitlink-jobs']);
      expect(component.loading()).toBe(false);
    });

    it('surfaces available:false (honest "not available", never a fabricated empty list)', () => {
      api.get.and.returnValue(of({ available: false, queues: [], reason: 'cf_403' }));
      component.loadQueues();
      expect(component.available()).toBe(false);
      expect(component.queues()).toEqual([]);
      expect(component.loading()).toBe(false);
    });

    it('surfaces an honest error on a transport failure', () => {
      api.get.and.returnValue(throwError(() => new Error('boom')));
      component.loadQueues();
      expect(component.loadError()).toContain('Could not load');
      expect(component.loading()).toBe(false);
    });
  });

  describe('selectQueue + loadDetail', () => {
    it('loads the describe from /admin/queues/:id (settings + producers/consumers)', () => {
      api.get.and.returnValue(
        of({
          found: true,
          id: 'q1',
          name: 'gitlink-jobs',
          created: null,
          modified: null,
          settings: { deliveryDelaySeconds: 0, messageRetentionSeconds: 345600 },
          producers: [{ type: 'worker', script: 'gitlink-api' }],
          consumers: [{ type: 'worker', script: 'gitlink-worker' }],
        }),
      );
      component.selectQueue('q1');
      expect(component.selectedId()).toBe('q1');
      expect(api.get).toHaveBeenCalledWith('/admin/queues/q1');
      expect(component.detail()?.found).toBe(true);
      expect(component.detail()?.consumers[0].script).toBe('gitlink-worker');
    });

    it('surfaces an honest error when the describe fails', () => {
      api.get.and.returnValue(throwError(() => new Error('x')));
      component.selectQueue('nope');
      expect(component.detailError()).toContain('Could not load');
    });
  });

  describe('formatting', () => {
    it('durationLabel renders seconds → human (null → em dash); dateLabel renders stored UTC', () => {
      expect(component.durationLabel(null)).toBe('—');
      expect(component.durationLabel(0)).toBe('0s');
      expect(component.durationLabel(30)).toBe('30s');
      expect(component.durationLabel(345600)).toBe('4.0d');
      expect(component.dateLabel(null)).toBe('—');
      expect(component.dateLabel('2026-09-01T12:34:56.000Z')).toBe('2026-09-01 12:34:56 UTC');
    });
  });
});
