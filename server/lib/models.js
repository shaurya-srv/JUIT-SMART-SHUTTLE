// Domain constants — mirrors src/core/models.h

const LOC_JUIT       = 0;
const LOC_RAVLI      = 1;
const LOC_PEACH_TREE = 2;
const LOC_WAKNAGHAT  = 3;
const LOC_COUNT      = 4;

const LOCATIONS = ['JUIT', 'Ravli PG', 'Peach Tree', 'Waknaghat'];

const MAX_BUS_CAPACITY = 30;
const MAX_BUSES        = 50;

function locationFromName(name) {
  const idx = LOCATIONS.indexOf(name);
  return idx >= 0 ? idx : -1;
}

function routeIsValid(pickup, dropoff) {
  return pickup >= 0 && pickup < LOC_COUNT &&
         dropoff >= 0 && dropoff < LOC_COUNT &&
         pickup !== dropoff;
}

module.exports = {
  LOC_JUIT, LOC_RAVLI, LOC_PEACH_TREE, LOC_WAKNAGHAT, LOC_COUNT,
  LOCATIONS, MAX_BUS_CAPACITY, MAX_BUSES,
  locationFromName, routeIsValid,
};
