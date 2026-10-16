import { forbidden } from './errors.js';
import { deletionAllowed } from '../services/settings.js';

/**
 * Deleting a financial record is off unless the owner has switched it on.
 *
 * The permission alone is not enough: a user may hold it from an earlier
 * configuration, and the whole point of the setting is that the organisation
 * decides whether anything may be destroyed at all. Checked on the server so
 * a hand-made request cannot get past a hidden button.
 */
export async function assertDeletionAllowed() {
  if (!(await deletionAllowed())) {
    throw forbidden('Deleting records is switched off. An owner can enable it in '
      + 'Settings under "Allow records to be deleted".');
  }
}
