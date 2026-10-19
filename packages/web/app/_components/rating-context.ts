'use client';

import { createContext } from 'react';
import type { TournamentTeamRatingsDto } from '@oantuti/protocol';

export const RatingContext = createContext<TournamentTeamRatingsDto | null>(null);
