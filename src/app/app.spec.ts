import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { App } from './app';
import { routes } from './app.routes';
import { PdfDesignExtractorComponent } from './pdf-design/pages/pdf-design-extractor/pdf-design-extractor.component';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter(routes)],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the PDF design extractor', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/edit', PdfDesignExtractorComponent);
    expect(harness.routeNativeElement?.tagName?.toLowerCase()).toBe('app-pdf-design-extractor');
  });
});
