export interface LndOptions {
    /**
     * The host and port of the gRPC interface of the Dockerized LND node.
     * Example: '127.0.0.1:10009'
     */
    socket: string;

    /**
     * The local file path to the node's TLS certificate (tls.cert).
     */
    certPath: string;

    /**
     * The local file path to the admin macaroon (admin.macaroon).
     */
    macaroonPath: string;
}
