import { Routes } from '@angular/router';
import { BgsTableComponent } from './bgs-table/bgs-table.component';

export const routes: Routes = [
  {
    path: '**',
    component: BgsTableComponent,
  },
];
