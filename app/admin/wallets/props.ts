/**
 * Serializable props for the copy-address client child.
 * Built field-by-field on the server — never by spreading an accounts object.
 */
export type CopyAddressProps = {
  address: string;
};

/** The exact prop object handed to `<CopyAddress>`. One field: `address`. */
export function copyAddressProps(address: string): CopyAddressProps {
  return { address };
}
