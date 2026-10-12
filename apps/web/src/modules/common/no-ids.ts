const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * A name or title as people read it: an id standing where a name should be (an ag-go video the agent added without
 * its name: "Chuẩn bị 01a0eb7a-…") reads as `unnamed` instead. Studio names those videos as soon as ag-go tells it.
 */
export const withoutIds = (text: string, unnamed: string): string => text.replace(UUID, unnamed);
