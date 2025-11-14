/**
 * Safely validates an object of updates and builds the necessary components
 * for an UPDATE SQL query (SET clauses and corresponding values).
 *
 * @param {object} updates - Key-value pairs of fields to update.
 * @param {object} allowedFields - A map of allowed field names to their required JavaScript type (e.g., {age: 'number', is_busy: 'boolean'}).
 * @returns {{setClauses: string, values: Array<any>}} An object containing the SET clause string and the array of values.
 * @throws {Error} If no valid updates are provided.
 */
function buildUpdateClauses(updates, allowedFields) {
	const columnsToUpdate = [];
	const values = [];

	for (const key in updates) {
		if (Object.prototype.hasOwnProperty.call(updates, key)) {
			const value = updates[key];
			const expectedType = allowedFields[key];

			// 1. Check if the key is allowed and the value type is correct
			if (expectedType && typeof value === expectedType) {
				columnsToUpdate.push(key);
				values.push(value);
			} else if (expectedType) {
				console.warn(
					`[Query Helper] Invalid type for key '${key}'. Expected ${expectedType}, received ${typeof value}. Skipping update.`
				);
			} else {
				console.warn(
					`[Query Helper] Update field '${key}' is not allowed. Skipping.`
				);
			}
		}
	}

	if (columnsToUpdate.length === 0) {
		throw new Error("No valid fields provided for update.");
	}

	// 2. Construct the parameterized SQL SET clause (e.g., "age = ?, is_busy = ?")
	const setClauses = columnsToUpdate.map((col) => `${col} = ?`).join(", ");

	return { setClauses, values };
}

module.exports = {
	buildUpdateClauses,
};
