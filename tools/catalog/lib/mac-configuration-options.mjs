// Official CTO browsing ranges are separate from exact retail pickup targets.
// upgradeOptions changes the chip, so it must never widen this chip's range.
const CORE_DIMENSION = 'processor-dimensionChip-cpuCoreCount-gpuCoreCount';
const capacityNumber = value => Number.parseFloat(value) * (/tb$/i.test(value) ? 1024 : 1);
function compatibleValues(options, dimension) {
  const values = Object.entries(options?.[dimension]?.compatibleOptions || {})
    .filter(([, value]) => value && value.isBlocked === false)
    .map(([value]) => value);
  if (!values.length || values.some(value => !/^\d+(?:gb|tb)$/.test(value))) throw Error(`invalid_cto_options:${dimension}`);
  return values.sort((a, b) => capacityNumber(a) - capacityNumber(b)).map(value => value.toUpperCase());
}

export function parseMacConfigurationOptions(response, expectedChipId) {
  const body = response?.body;
  const chipId = body?.selectedKits?.dimensions?.[CORE_DIMENSION]?.dimensionValue;
  const match = typeof chipId === 'string' && chipId.match(/^(m\d+)(max|ultra)-(\d+)-(\d+)$/);
  if (String(response?.head?.status) !== '200' || !match || chipId !== expectedChipId
    || body?.options?.[CORE_DIMENSION]?.compatibleOptions?.[chipId]?.isSelected !== true) throw Error('invalid_cto_chip_selection');
  return {
    chipId,
    chipName: `${match[1].toUpperCase()} ${match[2] === 'max' ? 'Max' : 'Ultra'}`,
    chip: `${match[3]}核CPU/${match[4]}核GPU`,
    memoryValues: compatibleValues(body.options, 'memory-dimensionMemory'),
    storageValues: compatibleValues(body.options, 'storage-dimensionCapacity'),
  };
}
