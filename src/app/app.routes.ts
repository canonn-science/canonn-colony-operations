import { Routes } from '@angular/router';
import { BgsTableComponent } from './bgs-table/bgs-table.component';
import { ColonyCensusComponent } from './colony-census/colony-census.component';

export const routes: Routes = [
  {
    path: 'census',
    component: ColonyCensusComponent,
  },
  {
    path: '**',
    component: BgsTableComponent,
  },
];
